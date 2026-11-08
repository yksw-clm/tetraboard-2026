import { DurableObject } from "cloudflare:workers";
import { matchmakingRules as rules, type MatchmakingState } from "@tetraboard/protocol";
import { releaseReservation, type AccountAdmission } from "../accounts/roomAccounts";
import { authSecret } from "../privacy/tokens";

type Wait = {
  accountId: string;
  operationId: string;
  controllerId: string;
  version: number;
  joinedAtMs: number;
  sequence: number;
  retryAtMs?: number;
  expiresAtMs: number;
};
type Player = Wait & {
  admission: AccountAdmission;
  tokenHash: string;
  released?: boolean;
  credentialPending?: boolean;
};
type Group = {
  id: string;
  roomId: string;
  instanceId: string;
  preparedAtMs: number;
  expiresAtMs: number;
  phase: "preparing" | "matched" | "playing" | "cancelling";
  players: Player[];
  remove?: string[];
  retryDelayMs?: number;
};
type State = { key: string; waiting: Wait[]; groups: Group[]; nextSequence?: number };
type Profile = {
  id: string;
  name: string;
  avatarKey: string | null;
  avatarPresetId: string | null;
  isAnonymous: number | null;
};
export type MatchmakingRoomInput = {
  matchId: string;
  roomId: string;
  instanceId: string;
  preparedAtMs: number;
  expiresAtMs: number;
  players: { admission: AccountAdmission; tokenHash: string; version: number }[];
};
export type MatchmakingRoomReservation = MatchmakingRoomInput & {
  phase: "waiting" | "playing" | "closed";
  startsAtMs?: number;
  connectedPlayerIds?: string[];
};
const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
export async function matchmakingCredential(env: Env, wait: Wait) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(authSecret(env)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const data = JSON.stringify([
    "tetraboard:matchmaking-membership:v1",
    rules.key,
    wait.accountId,
    wait.operationId,
    wait.controllerId,
    wait.version,
  ]);
  const token = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
  return {
    token,
    tokenHash: hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))),
  };
}
export class MatchmakingCoordinator extends DurableObject<Env> {
  private load(): State {
    return this.ctx.storage.kv.get<State>("state") ?? { key: rules.key, waiting: [], groups: [] };
  }
  private save(state: State) {
    this.ctx.storage.kv.put("state", state);
  }
  private async serial<T>(run: (state: State) => Promise<T>) {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.ctx.storage.setAlarm(Date.now() + 5000);
      const state = this.load();
      const result = await run(state);
      this.save(state);
      const deadlines = state.waiting.flatMap((w) => [
        w.expiresAtMs,
        Math.max(w.joinedAtMs + rules.fillAfterMs, w.retryAtMs ?? 0),
      ]);
      for (const group of state.groups) {
        if (group.phase !== "playing") deadlines.push(Date.now() + 1000, group.expiresAtMs);
        else if (group.players.some((p) => p.credentialPending)) deadlines.push(Date.now() + 1000);
      }
      if (deadlines.length)
        await this.ctx.storage.setAlarm(Math.max(Date.now() + 100, Math.min(...deadlines)));
      else await this.ctx.storage.deleteAlarm();
      return result;
    });
  }
  private async profile(accountId: string) {
    return this.env.APP_DB.prepare(
      `SELECT id,name,avatarKey,avatarPresetId,isAnonymous FROM user WHERE id=? AND profileCompleted=1 AND NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE id=user.id) AND NOT EXISTS(SELECT 1 FROM guest_account_merges WHERE guest_id=user.id)`,
    )
      .bind(accountId)
      .first<Profile>();
  }
  private locate(state: State, id: string) {
    const group = state.groups.find((g) =>
      g.players.some((p) => p.accountId === id && !p.released),
    );
    return {
      group,
      wait:
        group?.players.find((p) => p.accountId === id) ??
        state.waiting.find((w) => w.accountId === id),
    };
  }
  private async forget(wait: Wait) {
    this.ctx.storage.kv.put(`ended:${wait.operationId}`, true);
    await this.env.APP_DB.prepare(
      "DELETE FROM matchmaking_wait_reservations WHERE account_id=? AND operation_id=?",
    )
      .bind(wait.accountId, wait.operationId)
      .run();
  }
  private async rollback(
    state: State,
    group: Group,
    remove: string[],
    retryDelayMs = group.retryDelayMs ?? 0,
  ) {
    group.phase = "cancelling";
    group.remove = remove;
    group.retryDelayMs = retryDelayMs;
    this.save(state);
    const result = await this.env.GAME_ROOM.getByName(group.roomId).abortMatchmakingRoom(
      group.id,
      group.instanceId,
    );
    if (result.status === "already_started") {
      await this.releaseWaitingReservations(group);
      group.phase = "playing";
      delete group.remove;
      this.save(state);
      return;
    }
    for (const player of group.players) await releaseReservation(this.env, player.admission, true);
    for (const player of group.players) {
      if (
        remove.includes(player.accountId) ||
        !(await this.profile(player.accountId)) ||
        this.ctx.storage.kv.get(`ended:${player.operationId}`)
      )
        await this.forget(player);
      else {
        player.expiresAtMs = Date.now() + rules.leaseMs;
        player.retryAtMs = Date.now() + retryDelayMs;
        const updated = await this.env.APP_DB.prepare(
          "UPDATE matchmaking_wait_reservations SET match_operation_id=NULL,lease_until_ms=? WHERE account_id=? AND operation_id=?",
        )
          .bind(player.expiresAtMs, player.accountId, player.operationId)
          .run();
        if (updated.meta.changes && !state.waiting.some((w) => w.accountId === player.accountId))
          state.waiting.push({
            accountId: player.accountId,
            operationId: player.operationId,
            controllerId: player.controllerId,
            version: player.version,
            joinedAtMs: player.joinedAtMs,
            sequence: player.sequence,
            expiresAtMs: player.expiresAtMs,
            retryAtMs: player.retryAtMs,
          });
      }
    }
    state.groups = state.groups.filter((g) => g.id !== group.id);
    this.save(state);
  }
  private async releaseWaitingReservations(group: Group) {
    await this.env.APP_DB.batch(
      group.players.map((p) =>
        this.env.APP_DB.prepare(
          "DELETE FROM matchmaking_wait_reservations WHERE account_id=? AND operation_id=?",
        ).bind(p.accountId, p.operationId),
      ),
    );
  }
  private async recoverCredentials(state: State, group: Group) {
    for (const player of group.players) {
      if (!player.credentialPending || player.released) continue;
      player.tokenHash = (await matchmakingCredential(this.env, player)).tokenHash;
      this.save(state);
      const updated = await this.env.GAME_ROOM.getByName(group.roomId).rekeyMatchmakingPlayer(
        group.id,
        group.instanceId,
        player.admission.playerId,
        player.version,
        player.tokenHash,
      );
      if (updated) {
        player.credentialPending = false;
        this.save(state);
      } else {
        const seat = await this.env.APP_DB.prepare(
          "SELECT 1 FROM account_room_seats WHERE account_id=? AND operation_id=?",
        )
          .bind(player.accountId, player.admission.operationId)
          .first();
        if (!seat) {
          player.released = true;
          player.credentialPending = false;
          this.save(state);
        }
      }
    }
  }
  private async prepare(state: State, group: Group) {
    const statements: D1PreparedStatement[] = [];
    for (const player of group.players) {
      const profile = await this.profile(player.accountId);
      if (!profile || player.expiresAtMs <= Date.now()) {
        await this.rollback(state, group, [player.accountId]);
        return;
      }
      player.admission = {
        accountId: player.accountId,
        operationId: `${group.id}:${player.accountId}`,
        roomId: group.roomId,
        instanceId: group.instanceId,
        playerId: player.admission.playerId,
        name: profile.name,
        avatarKey: profile.avatarKey,
        avatarPresetId: profile.avatarPresetId,
        ...(profile.isAnonymous ? { isGuest: true } : {}),
      };
      player.tokenHash = (await matchmakingCredential(this.env, player)).tokenHash;
      const a = player.admission;
      statements.push(
        this.env.APP_DB.prepare(
          "UPDATE matchmaking_wait_reservations SET match_operation_id=? WHERE account_id=? AND operation_id=?",
        ).bind(a.operationId, a.accountId, player.operationId),
        this.env.APP_DB.prepare(`INSERT OR IGNORE INTO account_room_seats(account_id,operation_id,room_id,instance_id,player_id,name,avatar_key,avatar_preset_id,created_at_ms)
      SELECT u.id,?,?,?,?,u.name,?,?,? FROM user u JOIN matchmaking_wait_reservations w ON w.account_id=u.id WHERE u.id=? AND w.operation_id=? AND w.match_operation_id=? AND u.profileCompleted=1 AND u.name=? AND u.avatarKey IS ? AND u.avatarPresetId IS ? AND NOT EXISTS(SELECT 1 FROM deleted_accounts d WHERE d.id=u.id)`).bind(
          a.operationId,
          a.roomId,
          a.instanceId,
          a.playerId,
          a.avatarKey,
          a.avatarPresetId ?? null,
          Date.now(),
          a.accountId,
          player.operationId,
          a.operationId,
          a.name,
          a.avatarKey,
          a.avatarPresetId ?? null,
        ),
        this.env.APP_DB.prepare(
          "INSERT OR IGNORE INTO room_avatar_refs(operation_id,room_id,instance_id,player_id,avatar_key) SELECT operation_id,room_id,instance_id,player_id,avatar_key FROM account_room_seats WHERE operation_id=? AND avatar_key IS NOT NULL",
        ).bind(a.operationId),
        this.env.APP_DB.prepare(
          "INSERT OR IGNORE INTO privacy_room_accounts SELECT account_id,room_id FROM account_room_seats WHERE operation_id=?",
        ).bind(a.operationId),
        this.env.APP_DB.prepare(
          "INSERT OR IGNORE INTO privacy_room_players SELECT account_id,room_id,instance_id,player_id,avatar_key FROM account_room_seats WHERE operation_id=?",
        ).bind(a.operationId),
      );
    }
    this.save(state);
    try {
      await this.env.APP_DB.batch(statements);
    } catch {
      await this.rollback(state, group, [], 5000);
      return;
    }
    const created = await this.env.GAME_ROOM.getByName(group.roomId).prepareMatchmakingRoom({
      matchId: group.id,
      roomId: group.roomId,
      instanceId: group.instanceId,
      preparedAtMs: group.preparedAtMs,
      expiresAtMs: group.expiresAtMs,
      players: group.players.map((p) => ({
        admission: p.admission,
        tokenHash: p.tokenHash,
        version: p.version,
      })),
    });
    if (created.status !== "prepared") {
      await this.rollback(state, group, [], 5000);
      return;
    }
    group.phase = "matched";
    this.save(state);
  }
  private async tick(state: State) {
    for (const group of [...state.groups]) {
      if (group.phase === "playing") {
        if (group.players.some((p) => p.credentialPending))
          await this.recoverCredentials(state, group);
        continue;
      }
      if (group.phase === "cancelling") {
        await this.rollback(state, group, group.remove ?? []);
        continue;
      }
      if (group.phase === "preparing") {
        await this.prepare(state, group);
        continue;
      }
      await this.recoverCredentials(state, group);
      const room = await this.env.GAME_ROOM.getByName(group.roomId).getMatchmakingState(
        group.id,
        group.instanceId,
      );
      if (room.phase === "playing" || room.started) {
        await this.releaseWaitingReservations(group);
        group.phase = "playing";
        if (!room.occupiedPlayerIds.length) {
          for (const p of group.players) this.ctx.storage.kv.put(`ended:${p.operationId}`, true);
          state.groups = state.groups.filter((g) => g.id !== group.id);
        }
        for (const p of group.players)
          p.released = !room.occupiedPlayerIds.includes(p.admission.playerId);
        continue;
      }
      if (room.phase === "closed" || Date.now() >= group.expiresAtMs) {
        const connected = room.connectedPlayerIds;
        await this.rollback(
          state,
          group,
          group.players
            .filter((p) => !connected.includes(p.admission.playerId))
            .map((p) => p.accountId),
        );
      }
    }
    const validRows = state.waiting.length
      ? await this.env.APP_DB.prepare(
          `SELECT w.operation_id AS operationId FROM matchmaking_wait_reservations w JOIN user u ON u.id=w.account_id WHERE w.queue_key=? AND w.lease_until_ms>? AND u.profileCompleted=1 AND NOT EXISTS(SELECT 1 FROM deleted_accounts d WHERE d.id=u.id) AND NOT EXISTS(SELECT 1 FROM guest_account_merges m WHERE m.guest_id=u.id)`,
        )
          .bind(rules.key, Date.now())
          .all<{ operationId: string }>()
      : { results: [] };
    const valid = new Set(validRows.results.map((row) => row.operationId));
    for (const wait of [...state.waiting]) {
      if (
        wait.expiresAtMs <= Date.now() ||
        !valid.has(wait.operationId) ||
        this.ctx.storage.kv.get(`ended:${wait.operationId}`)
      ) {
        await this.forget(wait);
        state.waiting = state.waiting.filter((w) => w.operationId !== wait.operationId);
      }
    }
    state.waiting.sort(
      (a, b) => (a.sequence ?? 0) - (b.sequence ?? 0) || a.joinedAtMs - b.joinedAtMs,
    );
    let remaining = 4;
    while (remaining-- > 0) {
      const eligible = state.waiting.filter((w) => (w.retryAtMs ?? 0) <= Date.now());
      if (
        !eligible.length ||
        (eligible.length < 4 && eligible[0]!.joinedAtMs + rules.fillAfterMs > Date.now())
      )
        break;
      const selected = eligible.slice(0, 4);
      const ids = new Set(selected.map((w) => w.operationId));
      state.waiting = state.waiting.filter((w) => !ids.has(w.operationId));
      const id = crypto.randomUUID(),
        roomId = String(crypto.getRandomValues(new Uint32Array(1))[0]! % 100000).padStart(5, "0"),
        instanceId = crypto.randomUUID();
      const group: Group = {
        id,
        roomId,
        instanceId,
        preparedAtMs: Date.now(),
        expiresAtMs: Date.now() + rules.connectionGraceMs,
        phase: "preparing",
        players: selected.map((w) => ({
          ...w,
          released: false,
          credentialPending: false,
          tokenHash: "",
          admission: {
            accountId: w.accountId,
            operationId: `${id}:${w.accountId}`,
            roomId,
            instanceId,
            playerId: crypto.randomUUID(),
            name: "",
            avatarKey: null,
          },
        })),
      };
      state.groups.push(group);
      this.save(state);
      await this.prepare(state, group);
    }
  }
  private async snapshot(
    state: State,
    accountId: string,
    controllerId?: string,
    readonly = false,
  ): Promise<MatchmakingState> {
    const { wait, group } = this.locate(state, accountId);
    if (!wait) return { status: "idle", serverNowMs: Date.now() };
    if (group && group.phase !== "playing" && Date.now() >= group.expiresAtMs)
      return { status: "idle", serverNowMs: Date.now() };
    if (!group) {
      const lease = await this.env.APP_DB.prepare(
        "SELECT 1 FROM matchmaking_wait_reservations WHERE account_id=? AND operation_id=? AND lease_until_ms>?",
      )
        .bind(accountId, wait.operationId, Date.now())
        .first();
      if (wait.expiresAtMs <= Date.now() || !lease)
        return { status: "idle", serverNowMs: Date.now() };
    }
    if (group?.phase === "playing") {
      const seat = await this.env.APP_DB.prepare(
        "SELECT 1 FROM account_room_seats WHERE account_id=? AND operation_id=?",
      )
        .bind(
          accountId,
          group.players.find((p) => p.accountId === accountId)!.admission.operationId,
        )
        .first();
      if (!seat) {
        if (readonly) return { status: "idle", serverNowMs: Date.now() };
        group.players.find((p) => p.accountId === accountId)!.released = true;
        this.ctx.storage.kv.put(`ended:${wait.operationId}`, true);
        if (group.players.every((p) => p.released))
          state.groups = state.groups.filter((g) => g.id !== group.id);
        return { status: "idle", serverNowMs: Date.now() };
      }
    }
    const result: MatchmakingState = {
      status: group ? (group.phase === "playing" ? "playing" : "matched") : "waiting",
      serverNowMs: Date.now(),
      operationId: wait.operationId,
      controllerId: wait.controllerId,
      version: wait.version,
      joinedAtMs: wait.joinedAtMs,
      expiresAtMs: group?.expiresAtMs ?? wait.expiresAtMs,
    };
    if (
      group &&
      ["matched", "playing"].includes(group.phase) &&
      controllerId === wait.controllerId &&
      !("credentialPending" in wait && wait.credentialPending)
    ) {
      const player = group.players.find((p) => p.accountId === accountId)!;
      const credential = await matchmakingCredential(this.env, wait);
      result.assignment = {
        matchId: group.id,
        roomId: group.roomId,
        instanceId: group.instanceId,
        expiresAtMs: group.expiresAtMs,
        membership: {
          playerId: player.admission.playerId,
          role: group.players[0]?.accountId === accountId ? "host" : "player",
          token: credential.token,
        },
      };
    }
    return result;
  }
  async status(accountId: string, controllerId?: string) {
    return this.snapshot(this.load(), accountId, controllerId, true);
  }
  async join(accountId: string, operationId: string, controllerId: string) {
    return this.serial(async (state) => {
      await this.tick(state);
      const current = await this.snapshot(state, accountId, controllerId);
      if (current.status !== "idle")
        return current.operationId === operationId && current.controllerId === controllerId
          ? { ok: true as const, state: current }
          : { ok: false as const, message: "別のタブやルームで対局または待機中です。" };
      // 終了済みの同じ操作を遅延再送しても、新しい待機を作りません。
      if (this.ctx.storage.kv.get(`ended:${operationId}`) || !(await this.profile(accountId)))
        return {
          ok: false as const,
          message: "この待機は終了しています。もう一度操作してください。",
        };
      state.nextSequence = (state.nextSequence ?? 0) + 1;
      const wait: Wait = {
        sequence: state.nextSequence,
        accountId,
        operationId,
        controllerId,
        version: 1,
        joinedAtMs: Date.now(),
        expiresAtMs: Date.now() + rules.leaseMs,
      };
      try {
        await this.env.APP_DB.batch([
          this.env.APP_DB.prepare(
            "DELETE FROM tournament_wait_reservations WHERE account_id=? AND lease_until_ms<=? AND match_operation_id IS NULL",
          ).bind(accountId, Date.now()),
          this.env.APP_DB.prepare(
            "DELETE FROM matchmaking_wait_reservations WHERE account_id=? AND lease_until_ms<=? AND match_operation_id IS NULL",
          ).bind(accountId, Date.now()),
          this.env.APP_DB.prepare(
            "INSERT INTO matchmaking_wait_reservations(account_id,queue_key,operation_id,lease_until_ms) VALUES(?,?,?,?)",
          ).bind(accountId, rules.key, operationId, wait.expiresAtMs),
        ]);
      } catch {
        return {
          ok: false as const,
          message: "別のルームや大会で対局または待機中です。退出してから再試行してください。",
        };
      }
      state.waiting.push(wait);
      this.save(state);
      await this.tick(state);
      return { ok: true as const, state: await this.snapshot(state, accountId, controllerId) };
    });
  }
  async control(
    accountId: string,
    input: { operationId: string; controllerId: string; version: number },
    action: "heartbeat" | "cancel",
  ) {
    return this.serial(async (state) => {
      await this.tick(state);
      const { wait, group } = this.locate(state, accountId);
      if (
        !wait ||
        wait.operationId !== input.operationId ||
        wait.controllerId !== input.controllerId ||
        wait.version !== input.version
      )
        return { ok: false as const, message: "待機の操作元が変わったか、有効期限が切れました。" };
      if (action === "cancel") {
        if (group?.phase === "playing")
          return {
            ok: false as const,
            message: "対局が開始されています。対局画面へ戻ってください。",
          };
        this.ctx.storage.kv.put(`ended:${wait.operationId}`, true);
        if (group) await this.rollback(state, group, [accountId]);
        else {
          await this.forget(wait);
          state.waiting = state.waiting.filter((w) => w.operationId !== wait.operationId);
        }
      } else if (!group) {
        wait.expiresAtMs = Date.now() + rules.leaseMs;
        await this.env.APP_DB.prepare(
          "UPDATE matchmaking_wait_reservations SET lease_until_ms=? WHERE account_id=? AND operation_id=?",
        )
          .bind(wait.expiresAtMs, accountId, wait.operationId)
          .run();
      }
      return {
        ok: true as const,
        state: await this.snapshot(state, accountId, input.controllerId),
      };
    });
  }
  async takeover(
    accountId: string,
    operationId: string,
    controllerId: string,
    expectedVersion: number,
  ) {
    return this.serial(async (state) => {
      await this.tick(state);
      await this.snapshot(state, accountId, controllerId);
      const { wait, group } = this.locate(state, accountId);
      if (!wait || wait.operationId !== operationId)
        return { ok: false as const, message: "この待機は終了しています。" };
      if (
        wait.version !== expectedVersion &&
        !(wait.controllerId === controllerId && wait.version === expectedVersion + 1)
      )
        return {
          ok: false as const,
          message: "操作元が変わりました。状態を確認してから引き継いでください。",
        };
      if (wait.controllerId !== controllerId) {
        wait.controllerId = controllerId;
        wait.version++;
        if (group) group.players.find((p) => p.accountId === accountId)!.credentialPending = true;
        this.save(state);
        if (group) {
          const player = group.players.find((p) => p.accountId === accountId)!;
          await this.recoverCredentials(state, group);
          if (player.credentialPending) throw Error("操作元を復旧しています");
        }
      }
      return { ok: true as const, state: await this.snapshot(state, accountId, controllerId) };
    });
  }
  async leaveAccount(accountId: string) {
    return this.serial(async (state) => {
      await this.tick(state);
      const { wait, group } = this.locate(state, accountId);
      if (!wait) return;
      if (group?.phase === "playing") return;
      if (group) await this.rollback(state, group, [accountId]);
      else {
        await this.forget(wait);
        state.waiting = state.waiting.filter((w) => w.accountId !== accountId);
      }
    });
  }
  async purgeAccount(accountId: string) {
    await this.serial(async (state) => {
      const { wait, group } = this.locate(state, accountId);
      if (wait && group && group.phase !== "playing")
        await this.rollback(state, group, [accountId]);
      for (const waiting of state.waiting.filter((w) => w.accountId === accountId))
        await this.forget(waiting);
      state.waiting = state.waiting.filter((w) => w.accountId !== accountId);
      for (const group of state.groups)
        group.players = group.players.filter((p) => p.accountId !== accountId);
      state.groups = state.groups.filter((g) => g.players.length > 0);
    });
  }
  /** 毎時の既存保守から、解放済みの席だけをまとめて片付けます。 */
  async cleanupReleasedGroups() {
    return this.serial(async (state) => {
      const players = state.groups
        .filter((g) => g.phase === "playing")
        .flatMap((g) => g.players.filter((p) => !p.released));
      for (let offset = 0; offset < players.length; offset += 100) {
        const batch = players.slice(offset, offset + 100);
        const rows = await this.env.APP_DB.prepare(
          `SELECT operation_id FROM account_room_seats WHERE operation_id IN(${batch.map(() => "?").join(",")})`,
        )
          .bind(...batch.map((p) => p.admission.operationId))
          .all<{ operation_id: string }>();
        const occupied = new Set(rows.results.map((r) => r.operation_id));
        for (const p of batch)
          if (!occupied.has(p.admission.operationId)) {
            p.released = true;
            p.credentialPending = false;
            this.ctx.storage.kv.put(`ended:${p.operationId}`, true);
          }
      }
      state.groups = state.groups.filter(
        (g) => g.phase !== "playing" || g.players.some((p) => !p.released),
      );
    });
  }
  async alarm() {
    await this.serial(async (state) => {
      await this.tick(state);
    });
  }
}
