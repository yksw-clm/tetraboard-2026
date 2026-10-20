import { DurableObject } from "cloudflare:workers";
import { tournamentRules, type TournamentParticipation } from "@tetraboard/protocol";
import { releaseReservation, type AccountAdmission } from "../accounts/roomAccounts";
import { avatarKeyPattern } from "../accounts/auth";
import { finalizeTournament, readTournament, stage, type TournamentRow } from "./store";
import { tournamentCredential } from "./credentials";

type Waiting = {
  accountId: string;
  operationId: string;
  tokenHash: string;
  expiresAtMs: number;
  controllerId?: string;
  controllerVersion?: number;
  credentialDerived?: boolean;
  credentialPending?: boolean;
};
type Player = Waiting & { entryId: string; admission: AccountAdmission };
type Group = {
  id: string;
  roomId: string;
  instanceId: string;
  expiresAtMs: number;
  phase: "confirming" | "preparing" | "matched" | "playing" | "cancelling";
  players: Player[];
  remove?: string[];
};
type State = { key: string; waiting: Waiting[]; groups: Group[] };
type Result = { ok: true } | { ok: false; status: 400 | 403 | 409; message: string };
const ok: Result = { ok: true };
const fail = (message: string, status: 400 | 403 | 409 = 409): Result => ({
  ok: false,
  status,
  message,
});
const tokenKey = (_account: string, operation: string) => `cancel:${operation}`;
const controllerCancelKey = (operation: string, controllerId: string, version: number) =>
  `cancel-controller:${operation}:${controllerId}:${version}`;
const roomCode = () =>
  String(crypto.getRandomValues(new Uint32Array(1))[0]! % 100000).padStart(5, "0");

/** One persistent coordinator per published tournament. All externally visible transitions serialize here. */
export class TournamentCoordinator extends DurableObject<Env> {
  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = await this.ctx.blockConcurrencyWhile(async () => {
      try {
        // Register recovery before a D1/RPC side effect can outlive this request.
        await this.ctx.storage.setAlarm(Date.now() + 5000);
        return { success: true as const, value: await operation() };
      } catch (error: unknown) {
        await this.ctx.storage.setAlarm(Date.now() + 5000);
        return { success: false as const, error };
      }
    });
    if (!result.success) throw result.error;
    return result.value;
  }

  private load(key: string): State {
    const state = this.ctx.storage.kv.get<State>("state") ?? { key, waiting: [], groups: [] };
    if (state.key !== key) throw new Error("Tournament coordinator identity mismatch");
    return state;
  }
  private save(state: State) {
    this.ctx.storage.kv.put("state", state);
  }
  private async valid(accountId: string, key: string) {
    return this.env.APP_DB.prepare(`SELECT u.id,u.name,u.avatarKey,u.isAnonymous,e.id AS entryId FROM user u
      JOIN tournament_entries e ON e.account_id=u.id AND e.tournament_key=? AND e.deleted=0
      WHERE u.id=? AND u.profileCompleted=1 AND NOT EXISTS(SELECT 1 FROM deleted_accounts d WHERE d.id=u.id)`)
      .bind(key, accountId)
      .first<{ id: string; name: string; avatarKey: string | null; entryId: string }>();
  }
  private async waitingProfiles(key: string) {
    const rows =
      await this.env.APP_DB.prepare(`SELECT u.id,u.name,u.avatarKey,u.isAnonymous,e.id AS entryId,
      w.operation_id AS operationId FROM tournament_wait_reservations w
      JOIN tournament_entries e ON e.account_id=w.account_id AND e.tournament_key=w.tournament_key AND e.deleted=0
      JOIN user u ON u.id=w.account_id AND u.profileCompleted=1
      WHERE w.tournament_key=? AND w.lease_until_ms>?
      AND NOT EXISTS(SELECT 1 FROM deleted_accounts d WHERE d.id=u.id)`)
        .bind(key, Date.now())
        .all<{
          id: string;
          name: string;
          isAnonymous: number | null;
          avatarKey: string | null;
          entryId: string;
          operationId: string;
        }>();
    return new Map(rows.results.map((row) => [row.operationId, row]));
  }
  private locallyValid(wait: Waiting) {
    return (
      wait.expiresAtMs > Date.now() &&
      !this.ctx.storage.kv.get(tokenKey(wait.accountId, wait.operationId))
    );
  }
  private async leaseValid(wait: Waiting, key: string) {
    if (
      wait.expiresAtMs <= Date.now() ||
      this.ctx.storage.kv.get(tokenKey(wait.accountId, wait.operationId))
    )
      return false;
    return !!(await this.env.APP_DB.prepare(`SELECT 1 FROM tournament_wait_reservations w
      JOIN tournament_entries e ON e.account_id=w.account_id AND e.tournament_key=w.tournament_key AND e.deleted=0
      JOIN user u ON u.id=w.account_id AND u.profileCompleted=1
      WHERE w.account_id=? AND w.tournament_key=? AND w.operation_id=? AND w.lease_until_ms>?
      AND NOT EXISTS(SELECT 1 FROM deleted_accounts d WHERE d.id=w.account_id)`)
      .bind(wait.accountId, key, wait.operationId, Date.now())
      .first());
  }
  private async forget(wait: Waiting) {
    this.ctx.storage.kv.put(tokenKey(wait.accountId, wait.operationId), true);
    await this.env.APP_DB.prepare(
      "DELETE FROM tournament_wait_reservations WHERE account_id=? AND operation_id=?",
    )
      .bind(wait.accountId, wait.operationId)
      .run();
  }
  private async rollback(state: State, group: Group, remove: string[]) {
    group.phase = "cancelling";
    group.remove = remove;
    this.save(state);
    const result = await this.env.GAME_ROOM.getByName(group.roomId).abortTournamentRoom(
      group.id,
      group.players
        .filter((player) => remove.includes(player.accountId))
        .map((player) => player.admission.playerId),
    );
    if (result.status === "already_started") {
      group.phase = "playing";
      delete group.remove;
      this.save(state);
      return;
    }
    for (const player of group.players) await releaseReservation(this.env, player.admission, true);
    await this.env.APP_DB.prepare(
      "UPDATE tournament_matches SET phase='aborted',finished_at_ms=?,updated_at_ms=? WHERE id=? AND phase='reserved'",
    )
      .bind(Date.now(), Date.now(), group.id)
      .run();
    const row = await readTournament(this.env.APP_DB, state.key);
    for (const player of group.players) {
      if (
        remove.includes(player.accountId) ||
        !row ||
        stage(row) !== "active" ||
        this.ctx.storage.kv.get(tokenKey(player.accountId, player.operationId)) ||
        !(await this.valid(player.accountId, state.key))
      ) {
        await this.forget(player);
        continue;
      }
      player.expiresAtMs = Date.now() + tournamentRules.leaseMs;
      await this.env.APP_DB.prepare(`INSERT INTO tournament_wait_reservations(account_id,tournament_key,operation_id,lease_until_ms)
        VALUES(?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET match_operation_id=NULL,lease_until_ms=excluded.lease_until_ms
        WHERE tournament_wait_reservations.operation_id=excluded.operation_id`)
        .bind(player.accountId, state.key, player.operationId, player.expiresAtMs)
        .run();
      if (!state.waiting.some((w) => w.accountId === player.accountId))
        state.waiting.push({ ...player, credentialPending: false });
    }
    state.groups = state.groups.filter((g) => g.id !== group.id);
    this.save(state);
  }
  private async transfer(state: State, group: Group, row: TournamentRow) {
    group.phase = "preparing";
    this.save(state);
    const statements: D1PreparedStatement[] = [];
    const profiles = await this.waitingProfiles(state.key);
    for (const player of group.players) {
      const profile = profiles.get(player.operationId);
      if (!profile || !this.locallyValid(player)) {
        await this.rollback(state, group, [player.accountId]);
        return;
      }
      player.admission.name = profile.name;
      player.admission.avatarKey =
        profile.avatarKey && avatarKeyPattern.test(profile.avatarKey) ? profile.avatarKey : null;
      const a = player.admission;
      statements.push(
        this.env.APP_DB.prepare(
          "UPDATE tournament_wait_reservations SET match_operation_id=? WHERE account_id=? AND operation_id=?",
        ).bind(a.operationId, a.accountId, player.operationId),
        this.env.APP_DB.prepare(`INSERT INTO account_room_seats(account_id,operation_id,room_id,instance_id,player_id,name,avatar_key,created_at_ms)
          SELECT u.id,?,?,?,?,u.name,?,? FROM user u JOIN tournament_wait_reservations w ON w.account_id=u.id
          JOIN tournament_entries e ON e.account_id=u.id AND e.tournament_key=w.tournament_key AND e.deleted=0
          WHERE u.id=? AND w.operation_id=? AND w.tournament_key=? AND w.match_operation_id=? AND u.profileCompleted=1 AND u.name=? AND u.avatarKey IS ?
            AND NOT EXISTS(SELECT 1 FROM deleted_accounts d WHERE d.id=u.id)
          ON CONFLICT(account_id) DO NOTHING`).bind(
          a.operationId,
          a.roomId,
          a.instanceId,
          a.playerId,
          a.avatarKey,
          Date.now(),
          a.accountId,
          player.operationId,
          state.key,
          a.operationId,
          profile.name,
          profile.avatarKey,
        ),
        this.env.APP_DB.prepare(`INSERT OR IGNORE INTO room_avatar_refs(operation_id,room_id,instance_id,player_id,avatar_key)
          SELECT operation_id,room_id,instance_id,player_id,avatar_key FROM account_room_seats WHERE operation_id=? AND avatar_key IS NOT NULL`).bind(
          a.operationId,
        ),
        this.env.APP_DB.prepare(
          "INSERT OR IGNORE INTO privacy_room_accounts SELECT account_id,room_id FROM account_room_seats WHERE operation_id=?",
        ).bind(a.operationId),
        this.env.APP_DB.prepare(
          "INSERT OR IGNORE INTO privacy_room_players SELECT account_id,room_id,instance_id,player_id,avatar_key FROM account_room_seats WHERE operation_id=?",
        ).bind(a.operationId),
      );
    }
    this.save(state);
    await this.env.APP_DB.batch(statements);
    const prepared = await this.env.GAME_ROOM.getByName(group.roomId).prepareTournamentRoom({
      context: {
        tournamentId: row.public_id!,
        tournamentKey: row.key,
        matchId: group.id,
        startsAtMs: row.starts_at_ms!,
        endsAtMs: row.ends_at_ms!,
        ruleVersion: 1,
      },
      roomId: group.roomId,
      instanceId: group.instanceId,
      players: group.players.map((p) => ({
        admission: p.admission,
        tokenHash: p.tokenHash,
        credentialVersion: p.credentialDerived ? (p.controllerVersion ?? 0) : 0,
      })),
    });
    if (prepared.status !== "prepared" && prepared.status !== "already_prepared") {
      await this.rollback(state, group, []);
      return;
    }
    for (const player of group.players)
      if (player.credentialPending) await this.syncCredential(state, group, player);
    group.phase = "matched";
    group.expiresAtMs = Math.min(Date.now() + tournamentRules.connectionGraceMs, row.ends_at_ms!);
    // Retain the queue fence until preparation is known to have succeeded. The account seat now owns exclusion.
    await this.env.APP_DB.batch(
      group.players.map((p) =>
        this.env.APP_DB.prepare(
          "DELETE FROM tournament_wait_reservations WHERE account_id=? AND operation_id=?",
        ).bind(p.accountId, p.operationId),
      ),
    );
    this.save(state);
  }
  private async formGroup(state: State, row: TournamentRow) {
    if (state.waiting.length < 4 || stage(row) !== "active") return;
    const pool = [...state.waiting];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = crypto.getRandomValues(new Uint32Array(1))[0]! % (i + 1);
      [pool[i], pool[j]] = [pool[j]!, pool[i]!];
    }
    const selected = pool.slice(0, 4),
      id = crypto.randomUUID(),
      instanceId = crypto.randomUUID();
    let roomId = roomCode();
    for (let i = 0; i < 20; i++) {
      const used = await this.env.APP_DB.prepare(
        "SELECT 1 FROM room_index WHERE room_id=? AND closed=0 UNION ALL SELECT 1 FROM tournament_matches WHERE room_id=? AND phase IN ('reserved','playing','saving') LIMIT 1",
      )
        .bind(roomId, roomId)
        .first();
      if (!used) break;
      roomId = roomCode();
      if (i === 19) return;
    }
    const players: Player[] = [];
    const profiles = await this.waitingProfiles(state.key);
    for (const wait of selected) {
      const profile = profiles.get(wait.operationId);
      if (!profile || !this.locallyValid(wait)) return;
      players.push({
        ...wait,
        expiresAtMs: Math.min(Date.now() + tournamentRules.connectionGraceMs, row.ends_at_ms!),
        entryId: profile.entryId,
        admission: {
          accountId: wait.accountId,
          operationId: crypto.randomUUID(),
          roomId,
          instanceId,
          playerId: crypto.randomUUID(),
          name: profile.name,
          ...(profile.isAnonymous ? { isGuest: true } : {}),
          avatarKey:
            profile.avatarKey && avatarKeyPattern.test(profile.avatarKey)
              ? profile.avatarKey
              : null,
        },
      });
    }
    const group: Group = {
      id,
      roomId,
      instanceId,
      expiresAtMs: Math.min(Date.now() + tournamentRules.connectionGraceMs, row.ends_at_ms!),
      phase: "preparing",
      players,
    };
    state.waiting = state.waiting.filter((w) => !selected.some((s) => s.accountId === w.accountId));
    state.groups.push(group);
    this.save(state);
    await this.ensureGroup(state, group);
    await this.transfer(state, group, row);
  }
  private async ensureGroup(state: State, group: Group) {
    await this.env.APP_DB.batch([
      this.env.APP_DB.prepare(
        "INSERT OR IGNORE INTO tournament_matches(id,tournament_key,room_id,instance_id,phase,updated_at_ms) VALUES(?,?,?,?,'reserved',?)",
      ).bind(group.id, state.key, group.roomId, group.instanceId, Date.now()),
      ...group.players.flatMap((p) => [
        this.env.APP_DB.prepare(
          "INSERT OR IGNORE INTO tournament_match_players(match_id,entry_id,account_id,player_id,operation_id) VALUES(?,?,?,?,?)",
        ).bind(group.id, p.entryId, p.accountId, p.admission.playerId, p.admission.operationId),
        this.env.APP_DB.prepare(
          "UPDATE tournament_wait_reservations SET lease_until_ms=? WHERE account_id=? AND operation_id=?",
        ).bind(p.expiresAtMs, p.accountId, p.operationId),
      ]),
    ]);
  }
  private async syncCredential(state: State, group: Group, player: Player) {
    if (!player.credentialPending) return;
    const result = await this.env.GAME_ROOM.getByName(group.roomId).rekeyTournamentPlayer({
      matchId: group.id,
      instanceId: group.instanceId,
      accountId: player.accountId,
      operationId: player.admission.operationId,
      playerId: player.admission.playerId,
      version: player.controllerVersion ?? 0,
      tokenHash: player.tokenHash,
    });
    if (result.status === "stale") throw new Error("Tournament credential version mismatch");
    if (result.status === "not_found") return;
    player.credentialPending = false;
    this.save(state);
  }
  private async tick(state: State) {
    const row = await readTournament(this.env.APP_DB, state.key);
    if (!row || !row.published) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const active = stage(row) === "active";
    const profiles = state.waiting.length ? await this.waitingProfiles(state.key) : new Map();
    for (const wait of [...state.waiting])
      if (!active || !this.locallyValid(wait) || !profiles.has(wait.operationId)) {
        await this.forget(wait);
        state.waiting = state.waiting.filter((w) => w.operationId !== wait.operationId);
        this.save(state);
      }
    for (const group of [...state.groups]) {
      if (group.phase === "cancelling") {
        await this.rollback(state, group, group.remove ?? []);
        continue;
      }
      // 旧版で保存された参加確認待ちも、確認操作なしでルーム準備へ移します。
      if (group.phase === "confirming" || group.phase === "preparing") {
        await this.ensureGroup(state, group);
        if (!active || group.expiresAtMs <= Date.now()) {
          await this.rollback(
            state,
            group,
            group.players.map((p) => p.accountId),
          );
          continue;
        }
        const invalid: string[] = [];
        for (const p of group.players)
          if (!(await this.leaseValid(p, state.key))) invalid.push(p.accountId);
        if (invalid.length) {
          await this.rollback(state, group, invalid);
          continue;
        }
        await this.transfer(state, group, row);
      } else {
        for (const player of group.players)
          if (player.credentialPending) await this.syncCredential(state, group, player);
        const room =
          group.phase === "playing"
            ? null
            : await this.env.GAME_ROOM.getByName(group.roomId).getTournamentReservationState(
                group.id,
              );
        if (room?.startedAtMs !== undefined) {
          group.phase = "playing";
          this.save(state);
          await this.env.APP_DB.prepare(
            "UPDATE tournament_matches SET phase='playing',started_at_ms=?,updated_at_ms=? WHERE id=? AND phase='reserved'",
          )
            .bind(room.startedAtMs, Date.now(), group.id)
            .run();
        } else if (
          room &&
          (room.status === "closed" || !active || group.expiresAtMs <= Date.now())
        ) {
          const connected = room.connectedPlayerIds;
          // Recreate a lease only for clients that actually reached the room.
          for (const p of group.players)
            if (
              connected.includes(p.admission.playerId) &&
              (await this.valid(p.accountId, state.key))
            ) {
              p.expiresAtMs = Date.now() + tournamentRules.leaseMs;
            }
          await this.rollback(
            state,
            group,
            group.players
              .filter((p) => !connected.includes(p.admission.playerId))
              .map((p) => p.accountId),
          );
          continue;
        }
        if (group.phase === "playing") {
          const ledger = await this.env.APP_DB.prepare(
            "SELECT phase FROM tournament_matches WHERE id=?",
          )
            .bind(group.id)
            .first<{ phase: string }>();
          const occupied = await this.env.APP_DB.prepare(
            "SELECT 1 FROM account_room_seats WHERE instance_id=? LIMIT 1",
          )
            .bind(group.instanceId)
            .first();
          if (!occupied && (ledger?.phase === "saved" || ledger?.phase === "aborted")) {
            for (const player of group.players) await this.forget(player);
            state.groups = state.groups.filter((g) => g.id !== group.id);
            this.save(state);
          }
        }
      }
    }
    if (active)
      while (state.waiting.length >= 4) {
        const before = state.waiting.length;
        await this.formGroup(state, row);
        if (before === state.waiting.length) break;
      }
    await finalizeTournament(this.env.APP_DB, state.key);
    await this.schedule(state, row);
  }
  private async schedule(state: State, row: TournamentRow) {
    const now = Date.now();
    const next = [
      ...state.waiting.map((w) => w.expiresAtMs),
      ...state.groups.map((g) =>
        g.phase === "playing" || g.phase === "cancelling"
          ? now + 5000
          : Math.min(g.expiresAtMs, now + 5000),
      ),
      ...(row.finalized_at_ms === null ? [row.ends_at_ms!] : []),
    ].filter((n) => n > now);
    if (row.ends_at_ms! <= now && row.finalized_at_ms === null) {
      const fresh = await readTournament(this.env.APP_DB, row.key);
      if (fresh?.finalized_at_ms === null) next.push(now + 5000);
    }
    if (next.length) await this.ctx.storage.setAlarm(Math.min(...next));
    else await this.ctx.storage.deleteAlarm();
  }
  async refresh(key: string) {
    return this.serial(async () => {
      const state = this.load(key);
      this.save(state);
      await this.tick(state);
    });
  }
  async enroll(key: string, accountId: string): Promise<Result> {
    return this.serial(async () => {
      const row = await readTournament(this.env.APP_DB, key);
      if (!row || !["upcoming", "active"].includes(stage(row)))
        return fail("エントリー受付は終了しました。");
      await this.env.APP_DB.prepare(`INSERT OR IGNORE INTO tournament_entries(id,tournament_key,account_id,entered_at_ms)
        SELECT ?,?,id,? FROM user WHERE id=? AND profileCompleted=1 AND NOT EXISTS(SELECT 1 FROM deleted_accounts d WHERE d.id=user.id)`)
        .bind(crypto.randomUUID(), key, Date.now(), accountId)
        .run();
      return (await this.valid(accountId, key))
        ? ok
        : fail("プロフィール登録を完了してください。", 403);
    });
  }
  private async participation(
    state: State,
    accountId: string,
    controllerId?: string,
  ): Promise<TournamentParticipation> {
    const profile = await this.env.APP_DB.prepare(`SELECT w.operation_id AS waitingOperation,
      w.lease_until_ms AS leaseUntilMs,s.operation_id AS seatOperation,t.ends_at_ms AS endsAtMs
      FROM tournament_entries e JOIN user u ON u.id=e.account_id AND u.profileCompleted=1
      JOIN tournaments t ON t.key=e.tournament_key AND t.published=1
      LEFT JOIN tournament_wait_reservations w ON w.account_id=u.id AND w.tournament_key=e.tournament_key
      LEFT JOIN account_room_seats s ON s.account_id=u.id
      WHERE e.tournament_key=? AND e.account_id=? AND e.deleted=0
      AND NOT EXISTS(SELECT 1 FROM deleted_accounts d WHERE d.id=u.id)`)
      .bind(state.key, accountId)
      .first<{
        waitingOperation: string | null;
        leaseUntilMs: number | null;
        seatOperation: string | null;
        endsAtMs: number;
      }>();
    const entered = !!profile;
    if (!profile)
      return { entered: false, status: "idle", controller: "none", controllerVersion: 0 };
    const wait = state.waiting.find((w) => w.accountId === accountId);
    if (
      wait &&
      this.locallyValid(wait) &&
      profile.waitingOperation === wait.operationId &&
      (profile.leaseUntilMs ?? 0) > Date.now() &&
      profile.endsAtMs > Date.now()
    )
      return {
        entered,
        ...this.controller(wait, controllerId),
        status: "waiting",
        operationId: wait.operationId,
        expiresAtMs: wait.expiresAtMs,
      };
    for (const g of state.groups) {
      const p = g.players.find((p) => p.accountId === accountId);
      if (!p) continue;
      if (g.phase === "confirming" || g.phase === "preparing")
        return {
          entered,
          ...this.controller(p, controllerId),
          status: "waiting",
          operationId: p.operationId,
          expiresAtMs: g.expiresAtMs,
        };
      if (g.phase === "cancelling") continue;
      if (profile.seatOperation === p.admission.operationId)
        return {
          entered,
          ...this.controller(p, controllerId),
          status: g.phase === "playing" ? "playing" : "matched",
          operationId: p.operationId,
          matchId: g.id,
          roomId: g.roomId,
          instanceId: g.instanceId,
        };
    }
    return { entered, status: "idle", controller: "none", controllerVersion: 0 };
  }
  private controller(wait: Waiting, controllerId?: string) {
    return {
      controller:
        controllerId !== undefined && wait.controllerId === controllerId
          ? ("self" as const)
          : ("other" as const),
      controllerVersion: wait.controllerVersion ?? 0,
    };
  }
  private holder(state: State, accountId: string, operationId: string) {
    return (
      state.waiting.find(
        (player) => player.accountId === accountId && player.operationId === operationId,
      ) ??
      state.groups
        .flatMap((group) => group.players)
        .find((player) => player.accountId === accountId && player.operationId === operationId)
    );
  }
  async status(key: string, accountId: string, controllerId?: string) {
    return this.participation(this.load(key), accountId, controllerId);
  }
  async entryStatuses(key: string) {
    return this.serial(async () => {
      const state = this.load(key);
      await this.tick(state);
      const statuses: Record<string, "waiting" | "matched" | "playing"> = {};
      for (const w of state.waiting) statuses[w.accountId] = "waiting";
      for (const g of state.groups)
        for (const p of g.players) {
          const current = await this.participation(state, p.accountId);
          if (current.status !== "idle") statuses[p.accountId] = current.status;
        }
      return statuses;
    });
  }
  async enqueue(
    key: string,
    accountId: string,
    operationId: string,
    tokenHash: string,
    controllerId?: string,
  ): Promise<Result> {
    return this.serial(async () => {
      const state = this.load(key);
      const row = await readTournament(this.env.APP_DB, key);
      if (!row || stage(row) !== "active") return fail("現在は大会の対局を受け付けていません。");
      if (!(await this.valid(accountId, key)))
        return fail("先に大会へエントリーしてください。", 403);
      if (
        this.ctx.storage.kv.get(tokenKey(accountId, operationId)) ||
        (controllerId && this.ctx.storage.kv.get(controllerCancelKey(operationId, controllerId, 1)))
      )
        return fail("この待機は取り消されています。もう一度操作してください。");
      const existing = await this.participation(state, accountId);
      if (existing.status === "idle" && this.holder(state, accountId, operationId))
        return fail("この待機は終了しています。もう一度操作してください。");
      if (existing.status !== "idle")
        return existing.operationId === operationId &&
          this.holder(state, accountId, operationId)?.controllerId === controllerId
          ? ok
          : fail("別の操作元で対局または待機中です。");
      const wait: Waiting = {
        accountId,
        operationId,
        tokenHash,
        expiresAtMs: Date.now() + tournamentRules.leaseMs,
        ...(controllerId ? { controllerId, controllerVersion: 1 } : {}),
      };
      try {
        await this.env.APP_DB.batch([
          this.env.APP_DB.prepare(
            "DELETE FROM tournament_wait_reservations WHERE account_id=? AND lease_until_ms<=? AND match_operation_id IS NULL",
          ).bind(accountId, Date.now()),
          this.env.APP_DB.prepare(
            "INSERT INTO tournament_wait_reservations(account_id,tournament_key,operation_id,lease_until_ms) VALUES(?,?,?,?)",
          ).bind(accountId, key, operationId, wait.expiresAtMs),
        ]);
      } catch {
        return fail("別のルームや大会で対局または待機中です。退出してから再試行してください。");
      }
      state.waiting.push(wait);
      this.save(state);
      await this.tick(state);
      return ok;
    });
  }
  async heartbeat(
    key: string,
    accountId: string,
    operationId: string,
    controllerId?: string,
    controllerVersion?: number,
  ): Promise<Result> {
    return this.serial(async () => {
      const state = this.load(key);
      const holder = this.holder(state, accountId, operationId);
      if (
        holder &&
        (holder.controllerId !== controllerId || holder.controllerVersion !== controllerVersion)
      )
        return fail("操作元が別のタブに移りました。");
      const wait = state.waiting.find(
        (w) => w.accountId === accountId && w.operationId === operationId,
      );
      if (!wait) {
        const current = await this.participation(state, accountId, controllerId);
        return holder &&
          current.operationId === operationId &&
          ["matched", "playing"].includes(current.status)
          ? ok
          : fail("待機は終了しました。状態を再確認してください。");
      }
      if (!this.locallyValid(wait)) return fail("待機は終了しました。状態を再確認してください。");
      const expiresAtMs = Date.now() + tournamentRules.leaseMs;
      const updated = await this.env.APP_DB.prepare(
        `UPDATE tournament_wait_reservations SET lease_until_ms=? WHERE account_id=? AND operation_id=?
          AND lease_until_ms>? AND EXISTS(SELECT 1 FROM tournaments t JOIN tournament_entries e ON e.tournament_key=t.key
            JOIN user u ON u.id=e.account_id AND u.profileCompleted=1
            WHERE t.key=tournament_wait_reservations.tournament_key AND e.account_id=tournament_wait_reservations.account_id
            AND e.deleted=0 AND t.published=1 AND t.starts_at_ms<=? AND t.ends_at_ms>?
            AND NOT EXISTS(SELECT 1 FROM deleted_accounts d WHERE d.id=u.id))`,
      )
        .bind(expiresAtMs, accountId, operationId, Date.now(), Date.now(), Date.now())
        .run();
      if (!updated.meta.changes) return fail("待機は終了しました。");
      wait.expiresAtMs = expiresAtMs;
      this.save(state);
      return ok;
    });
  }
  async cancel(
    key: string,
    accountId: string,
    operationId: string,
    controllerId?: string,
    controllerVersion?: number,
  ): Promise<Result> {
    return this.serial(async () => {
      const state = this.load(key);
      const holder = this.holder(state, accountId, operationId);
      if (
        holder &&
        (holder.controllerId !== controllerId || holder.controllerVersion !== controllerVersion)
      )
        return fail("操作元が別のタブに移りました。");
      if (!holder) {
        // 待機POSTより先に届く取消は、その操作元の初期世代だけを失効させます。
        if (controllerId && controllerVersion !== undefined)
          this.ctx.storage.kv.put(
            controllerCancelKey(operationId, controllerId, controllerVersion),
            true,
          );
        return ok;
      }
      this.ctx.storage.kv.put(tokenKey(accountId, operationId), true);
      const wait = state.waiting.find(
        (w) => w.accountId === accountId && w.operationId === operationId,
      );
      if (wait) {
        await this.forget(wait);
        state.waiting = state.waiting.filter((w) => w !== wait);
        this.save(state);
      }
      const group = state.groups.find((g) =>
        g.players.some((p) => p.accountId === accountId && p.operationId === operationId),
      );
      if (group && group.phase !== "playing") await this.rollback(state, group, [accountId]);
      return ok;
    });
  }
  async claimController(
    key: string,
    accountId: string,
    input: {
      operationId: string;
      controllerId: string;
      takeover: boolean;
      expectedControllerVersion: number;
    },
  ) {
    return this.serial(async () => {
      const state = this.load(key);
      const holder = this.holder(state, accountId, input.operationId);
      const current = await this.participation(state, accountId, input.controllerId);
      if (
        !holder ||
        current.operationId !== input.operationId ||
        !(await this.valid(accountId, key))
      )
        return fail("参加中の待機や対局がありません。");
      if (!input.takeover && input.expectedControllerVersion !== (holder.controllerVersion ?? 0))
        return fail("操作元が更新されました。状態を再確認してください。");
      if (
        input.takeover &&
        holder.controllerId === input.controllerId &&
        input.expectedControllerVersion !== (holder.controllerVersion ?? 0) &&
        input.expectedControllerVersion !== (holder.controllerVersion ?? 0) - 1
      )
        return fail("操作元が更新されました。状態を再確認してください。");
      if (holder.controllerId !== input.controllerId) {
        if (!input.takeover || input.expectedControllerVersion !== (holder.controllerVersion ?? 0))
          return fail("操作元が更新されました。状態を再確認してください。");
        holder.controllerId = input.controllerId;
        holder.controllerVersion = (holder.controllerVersion ?? 0) + 1;
      }
      const credential = await tournamentCredential(this.env, {
        accountId,
        tournamentKey: key,
        operationId: holder.operationId,
        controllerId: input.controllerId,
        controllerVersion: holder.controllerVersion ?? 0,
      });
      if (holder.tokenHash !== credential.tokenHash || holder.credentialPending) {
        holder.tokenHash = credential.tokenHash;
        holder.credentialDerived = true;
        holder.credentialPending = true;
        this.save(state);
        const group = state.groups.find((group) => group.players.includes(holder as Player));
        if (group) await this.syncCredential(state, group, holder as Player);
        else {
          holder.credentialPending = false;
          this.save(state);
        }
      }
      const participation = await this.participation(state, accountId, input.controllerId);
      return participation.operationId === input.operationId &&
        participation.controller === "self" &&
        !this.holder(state, accountId, input.operationId)?.credentialPending
        ? { ok: true as const, participation, token: credential.token }
        : fail("参加中の待機や対局がありません。");
    });
  }
  async confirm(
    key: string,
    accountId: string,
    operationId: string,
    matchId: string,
    _accept: boolean,
  ): Promise<Result> {
    return this.serial(async () => {
      const state = this.load(key);
      await this.tick(state);
      const group = state.groups.find((g) => g.id === matchId),
        player = group?.players.find(
          (p) => p.accountId === accountId && p.operationId === operationId,
        );
      // 旧画面から遅れて届く承諾・拒否では、新方式の成立済み予約を変更しません。
      return group && player ? ok : fail("参加確認の受付は終了しました。");
    });
  }
  async purgeAccount(accountId: string) {
    return this.serial(async () => {
      const state = this.ctx.storage.kv.get<State>("state");
      if (!state) return;
      for (const w of state.waiting.filter((w) => w.accountId === accountId)) await this.forget(w);
      state.waiting = state.waiting.filter((w) => w.accountId !== accountId);
      this.save(state);
      for (const g of [...state.groups])
        if (g.players.some((p) => p.accountId === accountId)) {
          if (g.phase !== "playing") await this.rollback(state, g, [accountId]);
          if (g.phase === "playing") g.players = g.players.filter((p) => p.accountId !== accountId);
        }
      this.save(state);
      await this.tick(state);
    });
  }
  async cancelForAccount(accountId: string) {
    return this.serial(async () => {
      const state = this.ctx.storage.kv.get<State>("state");
      if (!state) return;
      for (const w of state.waiting.filter((w) => w.accountId === accountId)) await this.forget(w);
      state.waiting = state.waiting.filter((w) => w.accountId !== accountId);
      this.save(state);
      for (const g of [...state.groups])
        if (g.phase !== "playing" && g.players.some((p) => p.accountId === accountId)) {
          const player = g.players.find((p) => p.accountId === accountId)!;
          this.ctx.storage.kv.put(tokenKey(accountId, player.operationId), true);
          await this.rollback(state, g, [accountId]);
        }
      await this.tick(state);
    });
  }
  async publish(key: string, version: number): Promise<Result> {
    return this.serial(async () => {
      const db = this.env.APP_DB,
        row = await readTournament(db, key),
        now = Date.now();
      if (!row || row.version !== version)
        return fail("別の操作で更新されました。最新データを読み直してください。");
      if (row.published) return fail("この大会はすでに公開されています。");
      if (
        row.starts_at_ms === null ||
        row.ends_at_ms === null ||
        row.starts_at_ms <= now ||
        row.ends_at_ms <= row.starts_at_ms
      )
        return fail("未来の開始日時と、それより後の終了日時を設定してください。", 400);
      const latest = await db
        .prepare(
          "SELECT MAX(public_id) AS id,MAX(ends_at_ms) AS ends FROM tournaments WHERE published=1",
        )
        .first<{ id: number | null; ends: number | null }>();
      if (latest?.ends !== null && latest?.ends !== undefined && row.starts_at_ms < latest.ends)
        return fail("公開済みの最新大会の終了日時以降に設定してください。", 400);
      const changed = await db
        .prepare(
          "UPDATE tournaments SET public_id=?,published=1,version=version+1,updated_at_ms=? WHERE key=? AND version=? AND published=0",
        )
        .bind((latest?.id ?? 0) + 1, now, key, version)
        .run();
      if (!changed.meta.changes)
        return fail("別の操作で更新されました。最新データを読み直してください。");
      // Initial alarm registration is recoverable by public reads and the scheduled recovery job.
      await this.env.TOURNAMENT_COORDINATOR.getByName(key).refresh(key);
      return ok;
    });
  }
  async alarm() {
    await this.serial(async () => {
      const state = this.ctx.storage.kv.get<State>("state");
      if (state) await this.tick(state);
      else await this.ctx.storage.deleteAlarm();
    });
  }
}
