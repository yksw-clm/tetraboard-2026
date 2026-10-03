import {
  joinRoomContract,
  chatMessageSchema,
  chatEntrySchema,
  chatHistoryLimit,
  systemChatMessageSchema,
  chatTextSchema,
  membershipTokenSchema,
  roomMembershipSchema,
  roomPublicMetadataSchema,
  roomSchema,
  roundReplaySchema,
  roomSocketContract,
  isFourShogiRoom,
  isFourReversiRoom,
  type FourShogiRoom,
  type FourReversiRoom,
  type FourShogiReplayEvent,
  type FourShogiLastRound,
  type LastRound,
  type Room,
  type RoundReplay,
  type RoomMembership,
  type RoomMode,
  type RoomPublicMetadata,
  type RoomSocketClientMessage,
  type RoomSocketMessage,
  type ChatMessage,
  type ChatEntry,
  type RoomPresence,
  type SystemChatMessage,
} from "@tetraboard/protocol";
import {
  applyAction,
  chooseCpuMove,
  colors,
  createInitialState,
  eliminateColor,
  type FourReversiAction,
  type FourReversiState,
  type Color,
} from "@tetraboard/four-reversi";
import {
  applyAction as applyShogiAction,
  chooseCpuAction,
  createInitialState as createShogiState,
  eliminateSide,
  setDrawProposal,
  getLegalActions,
  getCheckState,
  sides,
  type Side,
  type FourShogiAction,
  type FourShogiState,
  type ExternalEliminationReason,
} from "@tetraboard/four-shogi";
import { ShogiStore } from "./shogiStore";
import {
  advanceShogiMatchSave,
  emptyKnockouts,
  pendingShogiMatchPrefix,
  shogiMatchStartKey,
  type ActiveShogiMatch,
  type PendingShogiMatch,
} from "./shogiMatchStore";
import { createShogiClock, advanceShogiClock } from "./shogiClock";
import { profileAvatarUrl } from "../accounts/auth";
import { releaseReservation, type AccountAdmission } from "../accounts/roomAccounts";
import { DurableObject } from "cloudflare:workers";
import { advanceClock, createClock, isClockExpired } from "./clock";
import { writeRoomIndex, type PendingRoomIndex } from "./roomIndex";
import {
  matchStartKey,
  pendingMatchPrefix,
  writeMatch,
  type MatchStart,
  type PendingMatch,
} from "./matchStore";

const accountKey = (playerId: string) => `seat-account:${playerId}`;
const cancelledAdmissionKey = (operationId: string) => `cancelled-admission:${operationId}`;
const accountCleanupKey = "account-cleanups";
type StoredAccountSeat = AccountAdmission & { occupying: boolean };
type AccountCleanup = { reservation: AccountAdmission; releaseAvatar: boolean; retryAtMs: number };
const roomStorageKey = "room";
const indexRevisionKey = "room-index-revision";
const pendingIndexKey = "room-index-pending";
const chatKey = "chat";
const replayKey = "round-replay";
const shogiCpuJobKey = "shogi-cpu-job";
type ShogiCpuJob = {
  roundId: string;
  positionRevision: number;
  side: Side;
  action: FourShogiAction;
  applyAt: number;
};
const mutedKey = "chat-muted";
const viewerSecretKey = "viewer-secret";
const disconnectedAtKey = (playerId: string) => `disconnected-at:${playerId}`;
const lastChatAtKey = (playerId: string) => `last-chat-at:${playerId}`;
const membershipStorageKey = (tokenHash: string) => `membership:${tokenHash}`;
const playerTokenKey = (playerId: string) => `player-token:${playerId}`;
const reconnectGraceMs = 30_000;
const cpuMoveDelayMs = 500;
const idleMs = 24 * 60 * 60 * 1000;
const chatIntervalMs = 3_000;
const departedKey = (playerId: string) => `departed:${playerId}`;
type RoomSocketError = Extract<RoomSocketMessage, { type: "room.error" }>["error"];
type CpuCommand = Extract<
  RoomSocketClientMessage,
  { type: "room.cpu.add" | "room.cpu.remove" | "room.cpu.level.set" }
>;

function currentCpu(room: Room): Extract<Room["players"][number], { kind: "cpu" }> | null {
  if (room.status !== "playing") return null;
  const player = isFourShogiRoom(room)
    ? room.players.find((entry) => entry.side === room.game.turn)
    : room.players.find((entry) => entry.color === room.game.turn);
  return player?.kind === "cpu" ? player : null;
}

function nextPublicUpdateAt(room: Room): number {
  return Math.max(Date.now(), room.publicUpdatedAtMs + 1);
}

async function hashMembershipToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join(
    "",
  );
}

function randomIndex(length: number): number {
  const range = 2 ** 32;
  const limit = Math.floor(range / length) * length;
  const value = new Uint32Array(1);
  do {
    crypto.getRandomValues(value);
  } while (value[0] >= limit);
  return value[0] % length;
}

function shuffledAssignments<T>(values: readonly T[]): T[] {
  const result: T[] = [...values];
  for (let index = result.length - 1; index > 0; index--) {
    const other = randomIndex(index + 1);
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g) ?? [], (part) => Number.parseInt(part, 16));
}

export class GameRoom extends DurableObject<Env> {
  private indexFlush: Promise<void> | null = null;
  private chatDirty = false;
  private accountFlush: Promise<void> | null = null;
  private matchFlush: Promise<void> | null = null;
  private shogiMatchFlush: Promise<void> | null = null;
  private shogiStore: ShogiStore | null = null;

  private shogi(): ShogiStore {
    return (this.shogiStore ??= new ShogiStore(this.ctx.storage.sql));
  }

  private pendingMatches() {
    return new Map(this.ctx.storage.kv.list<PendingMatch>({ prefix: pendingMatchPrefix }));
  }
  private pendingShogiMatches() {
    return new Map(
      this.ctx.storage.kv.list<PendingShogiMatch>({ prefix: pendingShogiMatchPrefix }),
    );
  }
  private async flushShogiMatches(): Promise<void> {
    if (this.shogiMatchFlush) return this.shogiMatchFlush;
    const flush = async () => {
      const next = [...this.pendingShogiMatches()].find(([, job]) => job.retryAtMs <= Date.now());
      if (next) {
        const [key, job] = next;
        try {
          const progress = await advanceShogiMatchSave(
            this.env.APP_DB,
            job.record,
            job.progress,
            (cursor) => this.shogi().replayEvents(job.record.id, cursor),
          );
          this.ctx.storage.transactionSync(() => {
            if (progress)
              this.ctx.storage.kv.put(key, { ...job, progress, retryAtMs: Date.now() + 1 });
            else {
              this.ctx.storage.kv.delete(key);
              const room = this.readRoom();
              const keep = Boolean(
                room &&
                isFourShogiRoom(room) &&
                room.status === "waiting" &&
                room.lastRound?.roundId === job.record.id,
              );
              this.shogi().releaseArchive(job.record.id, keep);
            }
          });
        } catch {
          console.error("Shogi match save will be retried", job.record.id);
          this.ctx.storage.kv.put(key, { ...job, retryAtMs: Date.now() + 5_000 });
        }
      }
      await this.syncAlarm(this.readRoom());
    };
    this.shogiMatchFlush = flush().finally(() => {
      this.shogiMatchFlush = null;
    });
    return this.shogiMatchFlush;
  }

  private async flushMatches(): Promise<void> {
    if (this.matchFlush) return this.matchFlush;
    const flush = async () => {
      for (;;) {
        const next = [...this.pendingMatches()].find(([, job]) => job.retryAtMs <= Date.now());
        if (!next) break;
        const [key, job] = next;
        try {
          await writeMatch(this.env.APP_DB, job.record);
          this.ctx.storage.kv.delete(key);
        } catch {
          console.error("Match save will be retried", job.record.id);
          this.ctx.storage.kv.put(key, { ...job, retryAtMs: Date.now() + 5_000 });
          break;
        }
      }
      await this.syncAlarm(this.readRoom());
    };
    this.matchFlush = flush().finally(() => {
      this.matchFlush = null;
    });
    return this.matchFlush;
  }

  private storedAccount(playerId: string) {
    return this.ctx.storage.kv.get<StoredAccountSeat>(accountKey(playerId)) ?? null;
  }

  private queueAccountCleanup(reservation: AccountAdmission, releaseAvatar: boolean) {
    const jobs = this.ctx.storage.kv.get<AccountCleanup[]>(accountCleanupKey) ?? [];
    const existing = jobs.find((job) => job.reservation.operationId === reservation.operationId);
    if (existing) existing.releaseAvatar ||= releaseAvatar;
    else jobs.push({ reservation, releaseAvatar, retryAtMs: Date.now() });
    this.ctx.storage.kv.put(accountCleanupKey, jobs);
  }

  private releaseAccount(playerId: string, removeAvatar: boolean) {
    const seat = this.storedAccount(playerId);
    if (!seat) return;
    this.ctx.storage.kv.put(cancelledAdmissionKey(seat.operationId), true);
    this.queueAccountCleanup(seat, removeAvatar);
    if (removeAvatar) this.ctx.storage.kv.delete(accountKey(playerId));
    else this.ctx.storage.kv.put(accountKey(playerId), { ...seat, occupying: false });
  }

  private async flushAccountCleanup(): Promise<void> {
    if (this.accountFlush) return this.accountFlush;
    const flush = async () => {
      for (;;) {
        const job = (this.ctx.storage.kv.get<AccountCleanup[]>(accountCleanupKey) ?? []).find(
          (entry) => entry.retryAtMs <= Date.now(),
        );
        if (!job) break;
        try {
          await releaseReservation(this.env, job.reservation, job.releaseAvatar);
          this.ctx.storage.transactionSync(() => {
            const jobs = this.ctx.storage.kv.get<AccountCleanup[]>(accountCleanupKey) ?? [];
            // A departure may have added image release while D1 was responding.
            const latest = jobs.find(
              (entry) => entry.reservation.operationId === job.reservation.operationId,
            );
            if (latest && latest.releaseAvatar && !job.releaseAvatar) return;
            this.ctx.storage.kv.put(
              accountCleanupKey,
              jobs.filter((entry) => entry.reservation.operationId !== job.reservation.operationId),
            );
            this.ctx.storage.kv.delete(cancelledAdmissionKey(job.reservation.operationId));
          });
        } catch {
          console.error("Account seat cleanup will be retried");
          const jobs = this.ctx.storage.kv.get<AccountCleanup[]>(accountCleanupKey) ?? [];
          for (const entry of jobs)
            if (entry.reservation.operationId === job.reservation.operationId)
              entry.retryAtMs = Date.now() + 5_000;
          this.ctx.storage.kv.put(accountCleanupKey, jobs);
          break;
        }
      }
      await this.syncAlarm(this.readRoom());
    };
    this.accountFlush = flush().finally(() => {
      this.accountFlush = null;
    });
    return this.accountFlush;
  }

  private async withAccountAdmission<T>(
    admission: AccountAdmission | undefined,
    action: () => T,
  ): Promise<T | null> {
    if (!admission) return action();
    const outcome = await this.ctx.blockConcurrencyWhile(async () => {
      try {
        if (this.ctx.storage.kv.get(cancelledAdmissionKey(admission.operationId)))
          return { ok: true as const, value: null };
        const reservation =
          await this.env.APP_DB.prepare(`SELECT operation_id FROM account_room_seats
        WHERE account_id = ? AND operation_id = ? AND room_id = ? AND instance_id = ? AND player_id = ? AND name = ? AND avatar_key IS ?`)
            .bind(
              admission.accountId,
              admission.operationId,
              this.ctx.id.name,
              admission.instanceId,
              admission.playerId,
              admission.name,
              admission.avatarKey,
            )
            .first();
        if (!reservation) return { ok: true as const, value: null };
        return { ok: true as const, value: action() };
      } catch (error) {
        // Expected admission rejection must not break the DO input gate.
        return {
          ok: false as const,
          message: error instanceof Error ? error.message : "Account admission failed",
        };
      }
    });
    if (!outcome.ok) throw new Error(outcome.message);
    return outcome.value;
  }

  async accountReservationState(
    admission: AccountAdmission,
  ): Promise<"occupied" | "released" | "pending"> {
    await this.reconcileDeadlines();
    const seat = this.storedAccount(admission.playerId);
    if (seat?.operationId === admission.operationId)
      return seat.occupying ? "occupied" : "released";
    return this.ctx.storage.kv.get(cancelledAdmissionKey(admission.operationId))
      ? "released"
      : "pending";
  }

  async cancelAccountReservation(admission: AccountAdmission) {
    await this.reconcileDeadlines();
    return this.ctx.blockConcurrencyWhile(async () => {
      const seat = this.storedAccount(admission.playerId);
      if (seat?.operationId === admission.operationId && seat.occupying)
        return { occupied: true, avatarReferenced: true };
      const room = this.readRoom();
      const avatarReferenced =
        room?.instanceId === admission.instanceId &&
        room.players.some(
          (player) =>
            player.id === admission.playerId &&
            player.kind === "human" &&
            player.avatarUrl === profileAvatarUrl(admission.avatarKey),
        );
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.kv.put(cancelledAdmissionKey(admission.operationId), true);
        this.queueAccountCleanup(admission, !avatarReferenced);
      });
      await this.syncAlarm(room);
      return { occupied: false, avatarReferenced: Boolean(avatarReferenced) };
    });
  }

  private readRoom(): Room | null {
    const saved = this.ctx.storage.kv.get<Room>(roomStorageKey);
    if (saved === undefined) return null;
    const room = roomSchema.parse(saved);
    // 旧保存データの理由は、記録されている棋譜からだけ復元します。
    if (
      isFourReversiRoom(room) &&
      room.status === "playing" &&
      !Object.hasOwn(saved, "eliminations")
    ) {
      const replay = this.ctx.storage.kv.get(replayKey);
      if (replay !== undefined) {
        for (const { action } of roundReplaySchema.parse(replay).steps) {
          if (
            action.type === "eliminate" &&
            room.game.eliminatedColors.includes(action.color) &&
            !room.eliminations.some((entry) => entry.color === action.color)
          )
            room.eliminations.push({ color: action.color, reason: action.reason });
        }
      }
    }
    return room;
  }

  private parseReversiRoom(value: unknown): FourReversiRoom {
    const room = roomSchema.parse(value);
    if (!isFourReversiRoom(room)) throw new Error("Expected Reversi room");
    return room;
  }

  private isPlayerEliminated(room: Room, playerId: string): boolean {
    if (room.status !== "playing") return false;
    if (isFourShogiRoom(room)) {
      const player = room.players.find((p) => p.id === playerId);
      return !!player && room.game.eliminations.some((e) => e.side === player.side);
    }
    const player = room.players.find((p) => p.id === playerId);
    return !!player && room.game.eliminatedColors.includes(player.color);
  }

  private readMembership(tokenHash: string): RoomMembership | null {
    const value = this.ctx.storage.kv.get(membershipStorageKey(tokenHash));
    return value === undefined ? null : roomMembershipSchema.parse(value);
  }

  private playerTokenHash(playerId: string): string | null {
    return this.ctx.storage.kv.get<string>(playerTokenKey(playerId)) ?? null;
  }

  // 復帰期限切れの退室は期限イベントで確定し、復帰待ちと脱落後の在室を含めます。
  private isHumanParticipant(player: Room["players"][number]): boolean {
    if (player.kind !== "human" || this.ctx.storage.kv.get(departedKey(player.id))) return false;
    if (this.storedAccount(player.id)?.occupying === false) return false;
    const hash = this.playerTokenHash(player.id);
    return hash !== null && this.readMembership(hash)?.playerId === player.id;
  }

  private closeIfNoHumanParticipants<T extends Room>(room: T | null): T | null {
    if (room === null || room.players.some((player) => this.isHumanParticipant(player)))
      return room;
    this.closeRoom();
    return null;
  }

  private readChat(): ChatEntry[] {
    return (this.ctx.storage.kv.get<unknown[]>(chatKey) ?? []).map((entry) =>
      chatEntrySchema.parse(entry),
    );
  }

  private appendSystem(event: SystemChatMessage["event"], text: string): void {
    const message = systemChatMessageSchema.parse({
      id: crypto.randomUUID(),
      kind: "system",
      event,
      text,
      sentAtMs: Date.now(),
    });
    this.ctx.storage.kv.put(chatKey, [...this.readChat(), message].slice(-chatHistoryLimit));
    this.chatDirty = true;
  }

  private playerLabel(player: Room["players"][number]): string {
    return player.kind === "cpu" ? `CPU Lv${player.level}` : player.name;
  }

  private recordDeparture(player: Room["players"][number]): void {
    if (this.ctx.storage.kv.get(departedKey(player.id))) return;
    if (this.readRoom()?.status === "playing")
      this.ctx.storage.kv.put(departedKey(player.id), true);
    this.appendSystem("left", `${this.playerLabel(player)}が退室しました`);
  }

  private presence(room: Room): RoomPresence {
    const host = room.players.find((player) => {
      const hash = this.playerTokenHash(player.id);
      return hash !== null && this.readMembership(hash)?.role === "host";
    });
    return {
      hostPlayerId: host?.id ?? null,
      connectedPlayerIds: room.players
        .filter((player) => {
          if (player.kind === "cpu") return true;
          const hash = this.playerTokenHash(player.id);
          return (
            hash !== null && this.readMembership(hash) !== null && this.hasOpenConnection(hash)
          );
        })
        .map((player) => player.id),
    };
  }

  private chatSnapshot(): RoomSocketMessage {
    return roomSocketContract.message.parse({
      type: "room.chat.snapshot",
      messages: this.readChat(),
    });
  }

  private broadcastChat(): void {
    this.chatDirty = false;
    const payload = JSON.stringify(this.chatSnapshot());
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      try {
        socket.send(payload);
      } catch {
        // 切断中の相手への配信失敗で、保存済みの投稿や操作を失敗にしません。
      }
    }
  }

  private closeRoom(): void {
    const room = this.readRoom();
    for (const player of room?.players ?? []) {
      if (player.kind !== "human") continue;
      this.releaseAccount(player.id, true);
      const tokenHash = this.playerTokenHash(player.id);
      if (tokenHash !== null) this.ctx.storage.kv.delete(membershipStorageKey(tokenHash));
      this.ctx.storage.kv.delete(playerTokenKey(player.id));
      this.ctx.storage.kv.delete(disconnectedAtKey(player.id));
      this.ctx.storage.kv.delete(lastChatAtKey(player.id));
      this.ctx.storage.kv.delete(departedKey(player.id));
    }
    this.ctx.storage.kv.delete(roomStorageKey);
    this.ctx.storage.kv.delete(replayKey);
    this.ctx.storage.kv.delete(matchStartKey);
    this.ctx.storage.kv.delete(shogiMatchStartKey);
    this.ctx.storage.kv.delete(chatKey);
    this.ctx.storage.kv.delete(mutedKey);
    this.ctx.storage.kv.delete(viewerSecretKey);
    this.ctx.storage.kv.delete(shogiCpuJobKey);
    if (room && isFourShogiRoom(room)) this.shogi().clear();
  }

  private recordElimination(
    room: Extract<FourReversiRoom, { status: "playing" }>,
    color: Color,
    reason: FourReversiRoom["eliminations"][number]["reason"],
    result: { state: FourReversiState; passedColors: readonly Color[] },
  ): void {
    // 呼び出し元のトランザクションで、理由を盤面・棋譜と一緒に保存します。
    room.eliminations.push({ color, reason });
    this.recordReplayStep({ type: "eliminate", color, reason }, result);
  }

  private recordReplayStep(
    action: RoundReplay["steps"][number]["action"],
    result: { state: FourReversiState; passedColors: readonly Color[] },
  ): void {
    const saved = this.ctx.storage.kv.get(replayKey);
    // 記録導入前に開始した対局の棋譜は、途中から補完しません。
    if (saved === undefined) return;
    const replay = roundReplaySchema.parse(saved);
    replay.steps.push(
      roundReplaySchema.shape.steps.element.parse({
        action,
        game: result.state,
        passedColors: result.passedColors,
      }),
    );
    this.ctx.storage.kv.put(replayKey, replay);
  }

  private finishGame(
    room: Extract<FourReversiRoom, { status: "playing" }>,
    game: Extract<FourReversiState, { status: "finished" }>,
    at: number,
  ): FourReversiRoom | null {
    const start = this.ctx.storage.kv.get<MatchStart>(matchStartKey);
    const replay = this.ctx.storage.kv.get<RoundReplay>(replayKey);
    if (start && replay && start.id === replay.id) {
      this.ctx.storage.kv.put(`${pendingMatchPrefix}${start.id}`, {
        record: { ...start, endedAtMs: at, game, eliminations: room.eliminations, replay },
        retryAtMs: Date.now(),
      } satisfies PendingMatch);
    }
    this.ctx.storage.kv.delete(matchStartKey);
    const lastRound = {
      game,
      replay: this.ctx.storage.kv.get(replayKey) ?? null,
      players: room.players.map((player) => ({
        id: player.id,
        name: this.playerLabel(player),
        color: player.color,
      })),
    };
    this.ctx.storage.kv.delete(replayKey);
    return this.finishToWaiting(room, lastRound as LastRound, at) as FourReversiRoom | null;
  }

  private finishToWaiting(
    room: Extract<Room, { status: "playing" }>,
    lastRound: LastRound | FourShogiLastRound,
    at: number,
  ): Room | null {
    const players = room.players.filter((player) => {
      if (player.kind === "cpu") return true;
      if (!this.isHumanParticipant(player)) return false;
      const hash = this.playerTokenHash(player.id);
      if (hash === null || this.readMembership(hash) === null) return false;
      if (this.hasOpenConnection(hash)) return true;
      const disconnectedAt = this.ctx.storage.kv.get<number>(disconnectedAtKey(player.id));
      return disconnectedAt !== undefined && disconnectedAt + reconnectGraceMs > at;
    });
    const humans = players.filter((player) => player.kind === "human");
    if (humans.length === 0) {
      this.closeRoom();
      return null;
    }
    for (const player of room.players) {
      if (player.kind !== "human" || players.includes(player)) continue;
      this.recordDeparture(player);
      this.releaseAccount(player.id, true);
      this.ctx.storage.kv.delete(departedKey(player.id));
      const hash = this.playerTokenHash(player.id);
      if (hash !== null) this.ctx.storage.kv.delete(membershipStorageKey(hash));
      this.ctx.storage.kv.delete(playerTokenKey(player.id));
      this.ctx.storage.kv.delete(disconnectedAtKey(player.id));
      this.ctx.storage.kv.delete(lastChatAtKey(player.id));
    }
    const host = humans.find((player) => {
      const hash = this.playerTokenHash(player.id);
      return hash !== null && this.readMembership(hash)?.role === "host";
    });
    const nextHost = host ?? humans[0];
    if (host === undefined) {
      const hash = this.playerTokenHash(nextHost.id)!;
      this.ctx.storage.kv.put(membershipStorageKey(hash), { playerId: nextHost.id, role: "host" });
    }
    const ordered = [nextHost, ...players.filter((player) => player.id !== nextHost.id)];
    for (const player of ordered) this.ctx.storage.kv.delete(departedKey(player.id));
    return roomSchema.parse({
      ...room,
      status: "waiting",
      eliminations: [],
      publicUpdatedAtMs: nextPublicUpdateAt(room),
      lastActivityAtMs: at,
      players: ordered.map((player) => ({
        ...Object.fromEntries(
          Object.entries(player).filter(([key]) => key !== "side" && key !== "color"),
        ),
        ready: player.kind === "cpu",
        ...(isFourShogiRoom(room) ? { side: null } : { color: null }),
        reconnectDeadline:
          player.kind === "cpu" || this.hasOpenConnection(this.playerTokenHash(player.id)!)
            ? null
            : this.ctx.storage.kv.get<number>(disconnectedAtKey(player.id))! + reconnectGraceMs,
      })),
      game: null,
      clock: null,
      lastRound,
      ...(isFourShogiRoom(room)
        ? {
            roundId: null,
            positionRevision: 0,
            legalActions: [],
            checkState: { south: false, west: false, north: false, east: false },
          }
        : {}),
    });
  }

  private startShogiGame(room: Extract<FourShogiRoom, { status: "waiting" }>): FourShogiRoom {
    const assignments = shuffledAssignments(sides);
    const players = room.players.map((player, index) => ({
      ...player,
      side: assignments[index],
      ready: player.kind === "cpu",
    }));
    const initial = {
      mode: room.settings.mode,
      threePlayerAttackProhibited: room.settings.threePlayerAttackProhibited,
      players: Object.fromEntries(players.map((p) => [p.side, p.id])) as Record<Side, string>,
    };
    const state = createShogiState(initial);
    const roundId = crypto.randomUUID();
    const at = Date.now();
    this.shogi().startReplay(roundId, initial);
    this.ctx.storage.kv.delete(shogiCpuJobKey);
    const started = roomSchema.parse({
      ...room,
      status: "playing",
      lastRound: null,
      players,
      roundId,
      positionRevision: 0,
      game: this.shogi().saveState(roundId, state),
      legalActions: getLegalActions(state),
      checkState: getCheckState(state),
      eliminations: [],
      clock: createShogiClock(at),
      publicUpdatedAtMs: nextPublicUpdateAt(room),
      lastActivityAtMs: at,
    });
    if (!isFourShogiRoom(started) || started.status !== "playing")
      throw new Error("Shogi game did not start");
    this.ctx.storage.kv.put(roomStorageKey, started);
    this.ctx.storage.kv.put(shogiMatchStartKey, {
      start: {
        id: roundId,
        roomId: room.id,
        instanceId: room.instanceId,
        startedAtMs: at,
        settings: room.settings,
        participants: started.players.map((player, seat) => ({
          id: player.id,
          name: this.playerLabel(player),
          side: player.side!,
          seat,
          ...(player.kind === "cpu"
            ? { kind: "cpu" as const, level: player.level }
            : {
                kind: "human" as const,
                accountId: this.storedAccount(player.id)?.accountId ?? null,
              }),
        })),
      },
      knockouts: emptyKnockouts(),
    } satisfies ActiveShogiMatch);
    return started as FourShogiRoom;
  }

  private acceptShogiState(
    room: Extract<FourShogiRoom, { status: "playing" }>,
    state: FourShogiState,
    event: FourShogiReplayEvent,
    at: number,
    turnEnded: boolean,
  ): FourShogiRoom | null {
    this.shogi().appendEvent(room.roundId, event);
    const core = this.shogi().saveState(room.roundId, state);
    const active = this.ctx.storage.kv.get<ActiveShogiMatch>(shogiMatchStartKey);
    if (
      active?.start.id === room.roundId &&
      event.type === "action" &&
      room.settings.mode === "singles"
    ) {
      const prior = new Set(room.game.eliminations.map((entry) => entry.side));
      const count = state.eliminations.filter(
        (entry) =>
          entry.reason === "checkmate" && entry.side !== event.side && !prior.has(entry.side),
      ).length;
      active.knockouts[event.side] += count;
      this.ctx.storage.kv.put(shogiMatchStartKey, active);
    }
    this.ctx.storage.kv.delete(shogiCpuJobKey);
    if (state.status === "finished") {
      if (active?.start.id === room.roundId) {
        this.shogi().protectArchive(room.roundId);
        this.ctx.storage.kv.put(pendingShogiMatchPrefix + room.roundId, {
          record: {
            ...active.start,
            endedAtMs: at,
            game: core as FourShogiLastRound["game"],
            knockouts: active.knockouts,
            replay: {
              rulesVersion: 1,
              initial: this.shogi().replayInfo(room.roundId),
              eventCount: this.shogi().eventCount(room.roundId),
            },
          },
          progress: { phase: "upload", cursor: 0 },
          retryAtMs: Date.now(),
        } satisfies PendingShogiMatch);
      }
      this.ctx.storage.kv.delete(shogiMatchStartKey);
      const lastRound: FourShogiLastRound = {
        roundId: room.roundId,
        game: core as FourShogiLastRound["game"],
        players: room.players.map((player) => ({
          id: player.id,
          name: this.playerLabel(player),
          side: player.side,
        })),
        eventCount: this.shogi().eventCount(room.roundId),
      };
      return this.finishToWaiting(room, lastRound, at) as FourShogiRoom | null;
    }
    return roomSchema.parse({
      ...room,
      game: core,
      eliminations: state.eliminations,
      positionRevision: room.positionRevision + 1,
      legalActions: getLegalActions(state),
      checkState: getCheckState(state),
      clock: advanceShogiClock(room.clock, room.game.turn, state.turn, at, turnEnded),
      lastActivityAtMs: at,
    }) as FourShogiRoom;
  }

  private eliminateShogiPlayer(
    room: Extract<FourShogiRoom, { status: "playing" }>,
    playerId: string,
    reason: ExternalEliminationReason,
    at: number,
  ): FourShogiRoom | null {
    const player = room.players.find((entry) => entry.id === playerId);
    if (!player) throw new Error("Unknown Shogi player");
    const clearDeadline = reason === "left" || reason === "disconnected";
    const players = room.players.map((entry) => ({
      ...entry,
      reconnectDeadline: entry.id === playerId && clearDeadline ? null : entry.reconnectDeadline,
    }));
    if (this.isPlayerEliminated(room, playerId))
      return roomSchema.parse({ ...room, players }) as FourShogiRoom;
    const { state, repetitionLookup } = this.shogi().loadTransition(room.roundId, room.game);
    const result = eliminateSide(state, player.side, reason, repetitionLookup);
    if (!result.ok) throw new Error(`Could not eliminate Shogi player: ${result.reason}`);
    const input = roomSchema.parse({ ...room, players }) as Extract<
      FourShogiRoom,
      { status: "playing" }
    >;
    return this.acceptShogiState(
      input,
      result.state,
      { type: "eliminate", side: player.side, reason },
      at,
      result.state.turn !== room.game.turn,
    );
  }

  private playShogi(
    tokenHash: string,
    action: FourShogiAction,
    roundId: string | undefined,
    positionRevision: number | undefined,
  ): { status: "placed"; room: Room | null } | { status: RoomSocketError } {
    return this.withIndexTransaction(() => {
      const room = this.readRoom();
      if (!room) return { status: "not_found" };
      if (!isFourShogiRoom(room)) return { status: "invalid_move" };
      if (room.status !== "playing")
        return { status: room.lastRound ? "game_finished" : "game_not_started" };
      const membership = this.readMembership(tokenHash);
      if (!membership) return { status: "unauthorized" };
      const player = room.players.find((p) => p.id === membership.playerId);
      if (!player) return { status: "unauthorized" };
      if (roundId !== room.roundId || positionRevision !== room.positionRevision)
        return { status: "stale_position" };
      if (isClockExpired(room.clock, Date.now())) return { status: "time_expired" };
      if (this.isPlayerEliminated(room, player.id)) return { status: "already_eliminated" };
      if (player.side !== room.game.turn) return { status: "not_your_turn" };
      const { state, repetitionLookup } = this.shogi().loadTransition(room.roundId, room.game);
      const result = applyShogiAction(state, player.side, action, repetitionLookup);
      if (!result.ok) return { status: "invalid_move" };
      const updated = this.acceptShogiState(
        room,
        result.state,
        { type: "action", side: player.side, action },
        Date.now(),
        true,
      );
      if (updated) this.ctx.storage.kv.put(roomStorageKey, updated);
      return { status: "placed", room: updated };
    });
  }

  private resignShogi(
    room: FourShogiRoom,
    tokenHash: string,
  ):
    | { status: "resigned"; room: Room | null }
    | {
        status:
          | "game_finished"
          | "game_not_started"
          | "unauthorized"
          | "already_eliminated"
          | "not_your_turn"
          | "time_expired";
      } {
    if (room.status !== "playing")
      return { status: room.lastRound ? "game_finished" : "game_not_started" };
    if (isClockExpired(room.clock, Date.now())) return { status: "time_expired" };
    const membership = this.readMembership(tokenHash);
    const player = room.players.find((p) => p.id === membership?.playerId);
    if (!player) return { status: "unauthorized" };
    if (this.isPlayerEliminated(room, player.id)) return { status: "already_eliminated" };
    if (player.side !== room.game.turn) return { status: "not_your_turn" };
    const updated = this.eliminateShogiPlayer(room, player.id, "resigned", Date.now());
    if (updated) this.ctx.storage.kv.put(roomStorageKey, updated);
    return { status: "resigned", room: updated };
  }

  private setShogiDrawProposal(
    tokenHash: string,
    command: Extract<RoomSocketClientMessage, { type: "room.game.draw.set" }>,
  ): { status: "updated" | "unchanged"; room: FourShogiRoom | null } | { status: RoomSocketError } {
    return this.withIndexTransaction(() => {
      const room = this.readRoom();
      if (!room) return { status: "not_found" };
      if (!isFourShogiRoom(room)) return { status: "invalid_request" };
      if (room.status !== "playing")
        return { status: room.lastRound ? "game_finished" : "game_not_started" };
      const membership = this.readMembership(tokenHash);
      const player = room.players.find((entry) => entry.id === membership?.playerId);
      if (!player) return { status: "unauthorized" };
      if (command.roundId !== room.roundId || command.positionRevision !== room.positionRevision)
        return { status: "stale_position" };
      const at = Date.now();
      if (isClockExpired(room.clock, at)) return { status: "time_expired" };
      const { state } = this.shogi().loadTransition(room.roundId, room.game);
      const result = setDrawProposal(state, player.side, command.proposed);
      if (!result.ok)
        return { status: result.reason === "invalid_proposal" ? "invalid_request" : result.reason };
      if (result.state === state) return { status: "unchanged", room };
      const updated = this.acceptShogiState(
        room,
        result.state,
        { type: "drawProposal", side: player.side, proposed: command.proposed },
        at,
        false,
      );
      if (updated) this.ctx.storage.kv.put(roomStorageKey, updated);
      return { status: "updated", room: updated };
    });
  }

  private setThreePlayerAttack(
    tokenHash: string,
    prohibited: boolean,
  ):
    | { status: "updated"; room: Room }
    | { status: "unchanged" | "not_found" | "forbidden" | "already_started" | "invalid_request" } {
    return this.withIndexTransaction(() => {
      const room = this.readRoom();
      if (!room) return { status: "not_found" };
      if (!isFourShogiRoom(room)) return { status: "invalid_request" };
      if (room.status !== "waiting") return { status: "already_started" };
      if (this.readMembership(tokenHash)?.role !== "host") return { status: "forbidden" };
      if (room.settings.threePlayerAttackProhibited === prohibited) return { status: "unchanged" };
      const updated = roomSchema.parse({
        ...room,
        settings: { ...room.settings, threePlayerAttackProhibited: prohibited },
        players: room.players.map((p) => (p.kind === "human" ? { ...p, ready: false } : p)),
        lastActivityAtMs: Date.now(),
        publicUpdatedAtMs: nextPublicUpdateAt(room),
      });
      this.ctx.storage.kv.put(roomStorageKey, updated);
      return { status: "updated", room: updated };
    });
  }

  async getShogiReplay(
    instanceId: string,
    roundId: string,
    cursor: number,
  ): Promise<
    | { status: "found"; page: import("@tetraboard/protocol").FourShogiReplayPage }
    | { status: "not_found" | "room_changed" }
  > {
    await this.reconcileDeadlines();
    const room = this.readRoom();
    if (!room) return { status: "not_found" };
    if (room.instanceId !== instanceId) return { status: "room_changed" };
    if (!isFourShogiRoom(room) || room.status !== "waiting" || room.lastRound?.roundId !== roundId)
      return { status: "not_found" };
    const page = this.shogi().getPage(instanceId, roundId, cursor);
    return page ? { status: "found", page } : { status: "not_found" };
  }

  private async reconcileShogiDeadlines(applyCpu: boolean): Promise<void> {
    const now = Date.now();
    const promoted: string[] = [];
    let changed = false;
    const updated = this.withIndexTransaction(() => {
      const saved = this.readRoom();
      if (!saved || !isFourShogiRoom(saved)) return saved;
      let room: FourShogiRoom | null = saved;
      if (room.lastActivityAtMs + idleMs <= now) {
        this.closeRoom();
        changed = true;
        return null;
      }
      if (this.closeIfNoHumanParticipants(room) === null) {
        changed = true;
        return null;
      }
      const players = room.players.map((player) => {
        const hash = this.playerTokenHash(player.id);
        const active = this.isHumanParticipant(player);
        if (
          player.kind !== "human" ||
          !active ||
          player.reconnectDeadline !== null ||
          hash === null ||
          this.hasOpenConnection(hash)
        )
          return player;
        const disconnectedAt = this.ctx.storage.kv.get<number>(disconnectedAtKey(player.id)) ?? now;
        this.ctx.storage.kv.put(disconnectedAtKey(player.id), disconnectedAt);
        changed = true;
        return { ...player, reconnectDeadline: disconnectedAt + reconnectGraceMs };
      });
      if (changed) {
        room = roomSchema.parse({ ...room, players }) as FourShogiRoom;
        this.ctx.storage.kv.put(roomStorageKey, room);
      }
      while (room) {
        const disconnect = room.players
          .map((player, index) => ({ player, index }))
          .filter(
            ({ player }) => player.reconnectDeadline !== null && player.reconnectDeadline <= now,
          )
          .sort(
            (a, b) =>
              a.player.reconnectDeadline! - b.player.reconnectDeadline! || a.index - b.index,
          )[0]?.player;
        const timeout =
          room.status === "playing" && isClockExpired(room.clock, now)
            ? room.clock.turnExpiresAt
            : null;
        if (timeout === null && !disconnect) break;
        if (
          room.status === "playing" &&
          timeout !== null &&
          (!disconnect || timeout <= disconnect.reconnectDeadline!)
        ) {
          const timedOut = room.players.find((player) => player.side === room!.game!.turn)!;
          room = this.eliminateShogiPlayer(room, timedOut.id, "timeout", timeout);
        } else if (disconnect) {
          if (room.status === "waiting") {
            const host = room.players[0].id === disconnect.id;
            room = this.removeWaitingPlayer(room, disconnect.id) as FourShogiRoom | null;
            if (host && room) {
              const hash = this.playerTokenHash(room.players[0].id);
              if (hash) promoted.push(hash);
            }
          } else {
            this.recordDeparture(disconnect);
            this.releaseAccount(disconnect.id, false);
            room = this.eliminateShogiPlayer(
              room,
              disconnect.id,
              "disconnected",
              disconnect.reconnectDeadline!,
            );
          }
        }
        room = this.closeIfNoHumanParticipants(room);
        changed = true;
        if (room) this.ctx.storage.kv.put(roomStorageKey, room);
      }
      const retained = this.closeIfNoHumanParticipants(room);
      if (retained !== room) changed = true;
      room = retained;
      if (
        applyCpu &&
        room?.status === "playing" &&
        room.clock.turnStartedAt + cpuMoveDelayMs <= now &&
        !isClockExpired(room.clock, now)
      ) {
        const cpu = currentCpu(room);
        if (cpu && "side" in cpu && cpu.side !== null) {
          const current = room;
          const humans = current.players.filter(
            (player) => player.kind === "human" && !this.isPlayerEliminated(current, player.id),
          );
          const proposed =
            humans.length > 0 &&
            humans.every((player) => current.game.drawProposals.includes(player.side));
          if (room.game.drawProposals.includes(cpu.side) !== proposed) {
            const { state } = this.shogi().loadTransition(room.roundId, room.game);
            const result = setDrawProposal(state, cpu.side, proposed);
            if (!result.ok) throw new Error("Could not update CPU draw proposal");
            room = this.acceptShogiState(
              room,
              result.state,
              { type: "drawProposal", side: cpu.side, proposed },
              now,
              false,
            );
            if (room) this.ctx.storage.kv.put(roomStorageKey, room);
            changed = true;
          }
          if (!room || room.status !== "playing") return room;
          const job = this.ctx.storage.kv.get<ShogiCpuJob>(shogiCpuJobKey);
          if (job) {
            if (
              job.roundId !== room.roundId ||
              job.positionRevision !== room.positionRevision ||
              job.side !== room.game.turn
            )
              this.ctx.storage.kv.delete(shogiCpuJobKey);
            else if (job.applyAt <= now) {
              const { state, repetitionLookup } = this.shogi().loadTransition(
                room.roundId,
                room.game,
              );
              const result = applyShogiAction(state, job.side, job.action, repetitionLookup);
              if (!result.ok) throw new Error("Saved CPU action is no longer legal");
              room = this.acceptShogiState(
                room,
                result.state,
                { type: "action", side: job.side, action: job.action },
                now,
                true,
              );
              if (room) this.ctx.storage.kv.put(roomStorageKey, room);
              changed = true;
            }
          } else {
            const { state, repetitionLookup } = this.shogi().loadTransition(
              room.roundId,
              room.game,
            );
            const action = chooseCpuAction(state, cpu.level, Math.random, repetitionLookup);
            if (!action) throw new Error("Shogi CPU has no legal action");
            // A separate alarm supplies a fresh wall clock after synchronous CPU work.
            this.ctx.storage.kv.put(shogiCpuJobKey, {
              roundId: room.roundId,
              positionRevision: room.positionRevision,
              side: room.game.turn,
              action,
              applyAt: Date.now() + 1,
            } satisfies ShogiCpuJob);
          }
        }
      }
      return room;
    });
    await this.syncAlarm(updated);
    await this.flushRoomIndex();
    await this.flushAccountCleanup();
    if (changed) {
      if (updated) this.broadcastRoom(updated);
      else this.closeSockets();
    }
    for (const hash of promoted) this.sendCurrentMembership(hash);
  }

  private publicMetadata(room: Room): RoomPublicMetadata {
    const host = room.players.find((player) => {
      if (player.kind !== "human") return false;
      const tokenHash = this.playerTokenHash(player.id);
      return tokenHash !== null && this.readMembership(tokenHash)?.role === "host";
    });
    const humanCount = room.players.filter((player) => player.kind === "human").length;
    return roomPublicMetadataSchema.parse({
      id: room.id,
      game: room.settings.game,
      mode: room.settings.mode,
      timeControl: room.settings.timeControl,
      status: room.status,
      hostName: host?.name ?? null,
      hostAvatarUrl: host?.kind === "human" ? host.avatarUrl : null,
      humanCount,
      cpuCount: room.players.length - humanCount,
      capacity: 4,
      openSeats: room.status === "waiting" ? 4 - room.players.length : 0,
      updatedAtMs: room.publicUpdatedAtMs,
    });
  }

  private withIndexTransaction<T>(action: () => T): T {
    let changed = false;
    const result = this.ctx.storage.transactionSync(() => {
      const before = this.readRoom();
      const previous = before === null ? null : this.publicMetadata(before);
      const value = action();
      const after = this.readRoom();
      changed =
        (before === null && after !== null) ||
        (before !== null && after === null) ||
        (before !== null && after !== null && after.publicUpdatedAtMs !== before.publicUpdatedAtMs);
      if (changed) {
        const revision = (this.ctx.storage.kv.get<number>(indexRevisionKey) ?? 0) + 1;
        const metadata = after === null ? previous : this.publicMetadata(after);
        if (metadata === null) throw new Error("Missing room metadata for index update");
        this.ctx.storage.kv.put(indexRevisionKey, revision);
        this.ctx.storage.kv.put(pendingIndexKey, {
          revision,
          closed: after === null,
          metadata,
          retryAtMs: Date.now(),
        } satisfies PendingRoomIndex);
      }
      return value;
    });
    if (changed) this.ctx.waitUntil(this.flushRoomIndex());
    if ((this.ctx.storage.kv.get<AccountCleanup[]>(accountCleanupKey) ?? []).length)
      this.ctx.waitUntil(this.flushAccountCleanup());
    if (this.pendingMatches().size) this.ctx.waitUntil(this.flushMatches());
    if (this.pendingShogiMatches().size) this.ctx.waitUntil(this.flushShogiMatches());
    return result;
  }

  private async flushRoomIndex(): Promise<void> {
    if (this.indexFlush !== null) return this.indexFlush;
    const flush = async () => {
      for (;;) {
        const pending = this.ctx.storage.kv.get<PendingRoomIndex>(pendingIndexKey);
        if (pending === undefined || pending.retryAtMs > Date.now()) break;
        try {
          await writeRoomIndex(this.env.APP_DB, pending);
          this.ctx.storage.transactionSync(() => {
            if (
              this.ctx.storage.kv.get<PendingRoomIndex>(pendingIndexKey)?.revision ===
              pending.revision
            )
              this.ctx.storage.kv.delete(pendingIndexKey);
          });
        } catch (error) {
          console.error("Room index update failed", error);
          this.ctx.storage.transactionSync(() => {
            const current = this.ctx.storage.kv.get<PendingRoomIndex>(pendingIndexKey);
            if (current?.revision === pending.revision) {
              this.ctx.storage.kv.put(pendingIndexKey, {
                ...current,
                retryAtMs: Date.now() + 5_000,
              } satisfies PendingRoomIndex);
            }
          });
          break;
        }
      }
      await this.syncAlarm(this.readRoom());
    };
    this.indexFlush = flush().finally(() => {
      this.indexFlush = null;
    });
    return this.indexFlush;
  }

  private hasOpenConnection(tokenHash: string, excluded?: WebSocket): boolean {
    return this.ctx.getWebSockets().some((socket) => {
      if (socket === excluded || socket.readyState !== WebSocket.OPEN) return false;
      const attachment: unknown = socket.deserializeAttachment();
      return (
        typeof attachment === "object" &&
        attachment !== null &&
        "tokenHash" in attachment &&
        attachment.tokenHash === tokenHash
      );
    });
  }

  private async syncAlarm(room: Room | null): Promise<void> {
    const deadlines =
      room?.players
        .filter((player) => player.kind === "human")
        .map((player) => player.reconnectDeadline)
        .filter((value) => value !== null) ?? [];
    if (room !== null) deadlines.push(room.lastActivityAtMs + idleMs);
    if (room?.status === "playing") {
      deadlines.push(room.clock.turnExpiresAt);
      if (currentCpu(room) !== null) {
        const job = isFourShogiRoom(room)
          ? this.ctx.storage.kv.get<ShogiCpuJob>(shogiCpuJobKey)
          : undefined;
        deadlines.push(job ? job.applyAt : room.clock.turnStartedAt + cpuMoveDelayMs);
      }
    }
    const pending = this.ctx.storage.kv.get<PendingRoomIndex>(pendingIndexKey);
    if (pending !== undefined) deadlines.push(pending.retryAtMs);
    for (const job of this.ctx.storage.kv.get<AccountCleanup[]>(accountCleanupKey) ?? [])
      deadlines.push(job.retryAtMs);
    for (const job of this.pendingMatches().values()) deadlines.push(job.retryAtMs);
    for (const job of this.pendingShogiMatches().values()) deadlines.push(job.retryAtMs);
    const next = deadlines.length === 0 ? null : Math.min(...deadlines);
    const current = await this.ctx.storage.getAlarm();
    if (next === current) return;
    if (next === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next);
  }

  async createRoom(
    room: Room,
    tokenHash: string,
    admission?: AccountAdmission,
  ): Promise<Room | null> {
    await this.reconcileDeadlines();
    const initialRoom = roomSchema.parse(room);

    if (initialRoom.id !== this.ctx.id.name) {
      throw new Error("Room code does not match Durable Object name");
    }

    const created = await this.withAccountAdmission(admission, () =>
      this.withIndexTransaction(() => {
        if (
          this.ctx.storage.kv.get(roomStorageKey) !== undefined ||
          this.ctx.storage.kv.get(membershipStorageKey(tokenHash)) !== undefined
        ) {
          return null;
        }

        const pendingRoom = roomSchema.parse({
          ...initialRoom,
          players: initialRoom.players.map((player) =>
            player.kind === "human"
              ? { ...player, reconnectDeadline: Date.now() + reconnectGraceMs }
              : player,
          ),
        });
        if (admission) {
          if (
            initialRoom.instanceId !== admission.instanceId ||
            initialRoom.players[0].id !== admission.playerId ||
            initialRoom.players[0].name !== admission.name ||
            initialRoom.players[0].kind !== "human" ||
            initialRoom.players[0].avatarUrl !== profileAvatarUrl(admission.avatarKey)
          )
            throw new Error("Admission does not match host");
          this.ctx.storage.kv.put(accountKey(admission.playerId), {
            ...admission,
            occupying: true,
          });
        }
        this.ctx.storage.kv.put(roomStorageKey, pendingRoom);
        this.ctx.storage.kv.put(
          membershipStorageKey(tokenHash),
          roomMembershipSchema.parse({ playerId: initialRoom.players[0].id, role: "host" }),
        );
        this.ctx.storage.kv.put(playerTokenKey(initialRoom.players[0].id), tokenHash);
        this.ctx.storage.kv.put(disconnectedAtKey(initialRoom.players[0].id), Date.now());
        for (const player of initialRoom.players) {
          this.appendSystem("joined", `${this.playerLabel(player)}が入室しました`);
        }
        const secret = new Uint8Array(32);
        crypto.getRandomValues(secret);
        this.ctx.storage.kv.put(
          viewerSecretKey,
          Array.from(secret, (byte) => byte.toString(16).padStart(2, "0")).join(""),
        );
        return pendingRoom;
      }),
    );
    if (created !== null) await this.syncAlarm(created);
    return created;
  }

  async getRoom(): Promise<Room | null> {
    await this.reconcileDeadlines();
    return this.readRoom();
  }

  async getRoomSnapshot() {
    const room = await this.getRoom();
    return room === null ? null : { room, presence: this.presence(room), serverNowMs: Date.now() };
  }

  async getPublicMetadata(): Promise<RoomPublicMetadata | null> {
    await this.reconcileDeadlines();
    const room = this.readRoom();
    if (room === null) return null;
    return this.publicMetadata(room);
  }

  async getRoomMembership(
    tokenHash: string,
  ): Promise<
    | { status: "found"; membership: RoomMembership }
    | { status: "not_found" }
    | { status: "unauthorized" }
  > {
    await this.reconcileDeadlines();
    const room = this.readRoom();
    if (room === null) {
      return { status: "not_found" };
    }

    const membership = this.readMembership(tokenHash);
    if (membership === null) {
      return { status: "unauthorized" };
    }

    return room.players.some(
      (player) => player.kind === "human" && player.id === membership.playerId,
    )
      ? { status: "found", membership }
      : { status: "unauthorized" };
  }

  async joinRoom(
    name: string,
    tokenHash: string,
    instanceId?: string,
    admission?: AccountAdmission,
  ): Promise<
    | { status: "joined"; room: Room; membership: RoomMembership }
    | { status: "not_found" }
    | { status: "room_full" }
    | { status: "room_started" }
    | { status: "room_changed" }
    | { status: "account_reservation_invalid" }
  > {
    await this.reconcileDeadlines();
    const playerName = joinRoomContract.request.parse({ name }).name!;
    const result = await this.withAccountAdmission(admission, () =>
      this.withIndexTransaction(() => {
        const room = this.readRoom();
        if (room === null) {
          return { status: "not_found" } as const;
        }
        if (instanceId !== undefined && room.instanceId !== instanceId) {
          return { status: "room_changed" } as const;
        }
        if (room.status !== "waiting") {
          return { status: "room_started" } as const;
        }
        if (room.players.length >= 4) {
          return { status: "room_full" } as const;
        }
        if (this.ctx.storage.kv.get(membershipStorageKey(tokenHash)) !== undefined) {
          throw new Error("Membership token collision");
        }

        if (
          admission &&
          (room.instanceId !== admission.instanceId || playerName !== admission.name)
        )
          throw new Error("Admission does not match room");
        const playerId = admission?.playerId ?? crypto.randomUUID();
        const updatedRoom = roomSchema.parse({
          ...room,
          publicUpdatedAtMs: nextPublicUpdateAt(room),
          lastActivityAtMs: Date.now(),
          players: [
            ...room.players,
            {
              id: playerId,
              name: playerName,
              kind: "human",
              avatarUrl: admission ? profileAvatarUrl(admission.avatarKey) : null,
              ready: false,
              ...(isFourShogiRoom(room) ? { side: null } : { color: null }),
              reconnectDeadline: Date.now() + reconnectGraceMs,
            },
          ],
        });
        const membership = roomMembershipSchema.parse({ playerId, role: "player" });
        this.ctx.storage.kv.put(roomStorageKey, updatedRoom);
        if (admission)
          this.ctx.storage.kv.put(accountKey(playerId), { ...admission, occupying: true });
        this.ctx.storage.kv.put(membershipStorageKey(tokenHash), membership);
        this.ctx.storage.kv.put(playerTokenKey(playerId), tokenHash);
        this.ctx.storage.kv.put(disconnectedAtKey(playerId), Date.now());
        this.appendSystem("joined", `${playerName}が入室しました`);
        return { status: "joined", room: updatedRoom, membership } as const;
      }),
    );

    if (result === null) return { status: "account_reservation_invalid" };
    if (result.status === "joined") {
      await this.syncAlarm(result.room);
      this.broadcastRoom(result.room);
    }

    return result;
  }

  private removeWaitingPlayer(
    room: Extract<Room, { status: "waiting" }>,
    playerId: string,
  ): Room | null {
    const departing = room.players.find((player) => player.id === playerId);
    if (departing) this.recordDeparture(departing);
    this.releaseAccount(playerId, true);
    const tokenHash = this.playerTokenHash(playerId);
    if (tokenHash !== null) this.ctx.storage.kv.delete(membershipStorageKey(tokenHash));
    this.ctx.storage.kv.delete(playerTokenKey(playerId));

    let remaining = room.players.filter((player) => player.id !== playerId);
    const successor = remaining.find((player) => player.kind === "human");
    if (successor === undefined) {
      this.closeRoom();
      return null;
    }

    if (room.players[0].id === playerId) {
      remaining = [successor, ...remaining.filter((player) => player.id !== successor.id)];
      const nextHash = this.playerTokenHash(successor.id);
      if (nextHash === null) throw new Error("Host successor has no membership");
      this.ctx.storage.kv.put(
        membershipStorageKey(nextHash),
        roomMembershipSchema.parse({ playerId: remaining[0].id, role: "host" }),
      );
    }
    const updated = roomSchema.parse({
      ...room,
      publicUpdatedAtMs: nextPublicUpdateAt(room),
      lastActivityAtMs: Date.now(),
      players: remaining,
    });
    this.ctx.storage.kv.put(roomStorageKey, updated);
    return updated;
  }

  private sendCurrentMembership(tokenHash: string): void {
    const membership = this.readMembership(tokenHash);
    if (membership === null) return;
    const message = JSON.stringify(
      roomSocketContract.message.parse({ type: "room.authenticated", membership }),
    );
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      const attachment: unknown = socket.deserializeAttachment();
      if (
        typeof attachment === "object" &&
        attachment !== null &&
        "tokenHash" in attachment &&
        attachment.tokenHash === tokenHash
      ) {
        socket.send(message);
      }
    }
  }

  private closeSockets(tokenHash?: string): void {
    for (const socket of this.ctx.getWebSockets()) {
      if (tokenHash !== undefined) {
        const attachment: unknown = socket.deserializeAttachment();
        if (
          typeof attachment !== "object" ||
          attachment === null ||
          !("tokenHash" in attachment) ||
          attachment.tokenHash !== tokenHash
        )
          continue;
      }
      if (tokenHash === undefined) {
        try {
          this.sendSocketError(socket, "not_found");
        } catch {
          // 通知に失敗しても接続を終了します。
        }
      }
      try {
        socket.close(1000, "Room membership ended");
      } catch {
        // 切断済みの接続は、そのまま無視します。
      }
    }
  }

  private async reconcileDeadlines(applyCpu = false): Promise<void> {
    const initial = this.readRoom();
    if (initial && isFourShogiRoom(initial)) {
      await this.reconcileShogiDeadlines(applyCpu);
      return;
    }
    const now = Date.now();
    const promoted: string[] = [];
    let changed = false;
    let closed = false;
    const room = this.withIndexTransaction(() => {
      let current: FourReversiRoom | null = initial;
      if (current === null) return current;
      if (current.lastActivityAtMs + idleMs <= now) {
        this.closeRoom();
        closed = true;
        changed = true;
        return null;
      }
      if (this.closeIfNoHumanParticipants(current) === null) {
        changed = true;
        closed = true;
        return null;
      }
      const disconnected = current.players.map((player) => {
        const tokenHash = this.playerTokenHash(player.id);
        const active = this.isHumanParticipant(player);
        if (
          !active ||
          player.reconnectDeadline !== null ||
          tokenHash === null ||
          this.hasOpenConnection(tokenHash)
        )
          return player;
        changed = true;
        const disconnectedAt = this.ctx.storage.kv.get<number>(disconnectedAtKey(player.id)) ?? now;
        this.ctx.storage.kv.put(disconnectedAtKey(player.id), disconnectedAt);
        return { ...player, reconnectDeadline: disconnectedAt + reconnectGraceMs };
      });
      if (changed) {
        current = this.parseReversiRoom({ ...current, players: disconnected });
        this.ctx.storage.kv.put(roomStorageKey, current);
      }
      while (current !== null) {
        const nextDisconnect:
          | { player: FourReversiRoom["players"][number]; index: number }
          | undefined = current.players
          .map((player, index) => ({ player, index }))
          .filter(
            ({ player }) => player.reconnectDeadline !== null && player.reconnectDeadline <= now,
          )
          .sort(
            (left, right) =>
              left.player.reconnectDeadline! - right.player.reconnectDeadline! ||
              left.index - right.index,
          )[0];
        const clockDeadline: number | null =
          current.status === "playing" && isClockExpired(current.clock, now)
            ? current.clock.turnExpiresAt
            : null;
        if (clockDeadline === null && nextDisconnect === undefined) break;

        if (
          current.status === "playing" &&
          clockDeadline !== null &&
          (nextDisconnect === undefined ||
            clockDeadline <= nextDisconnect.player.reconnectDeadline!)
        ) {
          const result = eliminateColor(current.game, current.game.turn);
          if (!result.ok) throw new Error("Could not eliminate timed-out player");
          this.recordElimination(current, current.game.turn, "timeout", result);
          const timedOutColor: Color = current.game.turn;
          current =
            result.state.status === "finished"
              ? (this.finishGame(current, result.state, clockDeadline) as FourReversiRoom | null)
              : this.parseReversiRoom({
                  ...current,
                  game: result.state,
                  clock: advanceClock(
                    current.clock,
                    timedOutColor,
                    result.state.turn,
                    clockDeadline,
                    true,
                  ),
                  lastActivityAtMs: clockDeadline,
                });
        } else if (nextDisconnect !== undefined) {
          const player: FourReversiRoom["players"][number] = nextDisconnect.player;
          if (current.status === "waiting") {
            const hostLeaving = current.players[0].id === player.id;
            current = this.removeWaitingPlayer(current, player.id) as FourReversiRoom | null;
            if (hostLeaving && current !== null) {
              const successor = this.playerTokenHash(current.players[0].id);
              if (successor !== null) promoted.push(successor);
            }
            if (current === null) closed = true;
          } else {
            this.recordDeparture(player);
            this.releaseAccount(player.id, false);
            if (player.color !== null && current.game.eliminatedColors.includes(player.color)) {
              current = this.parseReversiRoom({
                ...current,
                players: current.players.map((entry) =>
                  entry.id === player.id ? { ...entry, reconnectDeadline: null } : entry,
                ),
              });
              current = this.closeIfNoHumanParticipants(current);
              if (current) this.ctx.storage.kv.put(roomStorageKey, current);
              changed = true;
              continue;
            }
            if (player.color === null) throw new Error("Playing player has no color");
            const result = eliminateColor(current.game, player.color);
            if (!result.ok) throw new Error("Could not eliminate disconnected player");
            this.recordElimination(current, player.color, "disconnected", result);
            current =
              result.state.status === "finished"
                ? (this.finishGame(
                    current,
                    result.state,
                    player.reconnectDeadline!,
                  ) as FourReversiRoom | null)
                : this.parseReversiRoom({
                    ...current,
                    game: result.state,
                    clock: advanceClock(
                      current.clock,
                      current.game.turn,
                      result.state.turn,
                      player.reconnectDeadline!,
                      result.state.turn !== current.game.turn,
                    ),
                    players: current.players.map((entry) => ({
                      ...entry,
                      reconnectDeadline: entry.id === player.id ? null : entry.reconnectDeadline,
                    })),
                    lastActivityAtMs: player.reconnectDeadline!,
                  });
          }
        }
        current = this.closeIfNoHumanParticipants(current);
        changed = true;
        if (current !== null) this.ctx.storage.kv.put(roomStorageKey, current);
      }
      const retained = this.closeIfNoHumanParticipants(current);
      if (retained !== current) changed = true;
      current = retained;
      if (
        current?.status === "playing" &&
        current.clock.turnStartedAt + cpuMoveDelayMs <= now &&
        !isClockExpired(current.clock, now)
      ) {
        const cpu = currentCpu(current);
        if (cpu !== null) {
          const move = chooseCpuMove(current.game, cpu.level);
          if (move === null) throw new Error("CPU has no legal move");
          const decidedAt = Date.now();
          const expired = isClockExpired(current.clock, decidedAt);
          const result = expired
            ? eliminateColor(current.game, current.game.turn)
            : applyAction(current.game, { type: "placeStone", position: move });
          if (!result.ok) throw new Error("CPU selected an invalid move");
          if (expired) this.recordElimination(current, current.game.turn, "timeout", result);
          else
            this.recordReplayStep(
              { type: "place", color: current.game.turn, position: move },
              result,
            );
          current =
            result.state.status === "finished"
              ? (this.finishGame(current, result.state, decidedAt) as FourReversiRoom | null)
              : this.parseReversiRoom({
                  ...current,
                  game: result.state,
                  clock: advanceClock(
                    current.clock,
                    current.game.turn,
                    result.state.turn,
                    expired ? current.clock.turnExpiresAt : decidedAt,
                    true,
                  ),
                  lastActivityAtMs: decidedAt,
                });
          if (current !== null) this.ctx.storage.kv.put(roomStorageKey, current);
          changed = true;
        }
      }
      if (current === null) closed = true;
      return current;
    });

    await this.syncAlarm(room);
    await this.flushRoomIndex();
    await this.flushAccountCleanup();
    this.ctx.waitUntil(this.flushMatches());
    if (!changed) return;
    if (closed) this.closeSockets();
    else if (room !== null) this.broadcastRoom(room);
    for (const tokenHash of promoted) this.sendCurrentMembership(tokenHash);
  }

  async alarm(): Promise<void> {
    await this.reconcileDeadlines(true);
  }

  async leaveRoom(tokenHash: string): Promise<"left" | "not_found" | "unauthorized"> {
    await this.reconcileDeadlines();
    let promoted: string | null = null;
    const result = this.withIndexTransaction(() => {
      const room = this.readRoom();
      if (room === null) return { status: "not_found" as const, room: null };
      if (room.status === "playing" && isClockExpired(room.clock, Date.now())) {
        return { status: "time_expired" as const, room };
      }
      const membership = this.readMembership(tokenHash);
      if (membership === null) return { status: "unauthorized" as const, room };
      const player = room.players.find((entry) => entry.id === membership.playerId);
      if (player === undefined) return { status: "unauthorized" as const, room };

      let updated: Room | null;
      if (room.status === "waiting") {
        const hostLeaving = room.players[0].id === player.id;
        updated = this.removeWaitingPlayer(room, player.id);
        if (hostLeaving && updated !== null) promoted = this.playerTokenHash(updated.players[0].id);
      } else if (isFourShogiRoom(room)) {
        this.recordDeparture(player);
        this.releaseAccount(player.id, false);
        this.ctx.storage.kv.delete(membershipStorageKey(tokenHash));
        this.ctx.storage.kv.delete(playerTokenKey(player.id));
        const at = Date.now();
        updated = this.eliminateShogiPlayer(room, player.id, "left", at);
        if (updated) {
          updated = roomSchema.parse({
            ...updated,
            publicUpdatedAtMs:
              membership.role === "host" && updated.status === "playing"
                ? nextPublicUpdateAt(room)
                : updated.publicUpdatedAtMs,
            lastActivityAtMs: at,
          });
          this.ctx.storage.kv.put(roomStorageKey, updated);
        }
      } else {
        const player = room.players.find((entry) => entry.id === membership.playerId)!;
        this.recordDeparture(player);
        this.releaseAccount(player.id, false);
        const game =
          room.status === "playing" &&
          player.color !== null &&
          !room.game.eliminatedColors.includes(player.color)
            ? eliminateColor(room.game, player.color)
            : null;
        if (game !== null && !game.ok) throw new Error("Could not eliminate leaving player");
        if (game?.ok && player.color !== null)
          this.recordElimination(room, player.color, "left", game);
        this.ctx.storage.kv.delete(membershipStorageKey(tokenHash));
        this.ctx.storage.kv.delete(playerTokenKey(player.id));
        const at = Date.now();
        updated =
          game?.ok && game.state.status === "finished"
            ? this.finishGame(room, game.state, at)
            : roomSchema.parse({
                ...room,
                publicUpdatedAtMs:
                  membership.role === "host" ? nextPublicUpdateAt(room) : room.publicUpdatedAtMs,
                game: game?.ok ? game.state : room.game,
                clock: game?.ok
                  ? advanceClock(
                      room.clock,
                      room.game.turn,
                      game.state.turn,
                      at,
                      game.state.turn !== room.game.turn,
                    )
                  : room.clock,
                players: room.players.map((entry) => ({
                  ...entry,
                  reconnectDeadline: entry.id === player.id ? null : entry.reconnectDeadline,
                })),
                lastActivityAtMs: at,
              });
        if (updated !== null) this.ctx.storage.kv.put(roomStorageKey, updated);
      }
      updated = this.closeIfNoHumanParticipants(updated);
      return { status: "left" as const, room: updated };
    });
    if (result.status === "time_expired") {
      await this.reconcileDeadlines();
      return this.leaveRoom(tokenHash);
    }
    if (result.status !== "left") return result.status;
    await this.syncAlarm(result.room);
    if (result.room === null) this.closeSockets();
    else this.broadcastRoom(result.room);
    if (promoted !== null) this.sendCurrentMembership(promoted);
    this.closeSockets(tokenHash);
    return "left";
  }

  private broadcastRoom(room: Room): void {
    const message = JSON.stringify(this.roomSnapshot(room));
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      try {
        socket.send(message);
      } catch {
        // 切断中の接続への送信失敗は、保存済みのルーム状態に影響させません。
      }
    }
    if (this.chatDirty) this.broadcastChat();
    if (room.status === "waiting" && room.lastRound !== null) {
      const host = room.players.find(
        (player) =>
          player.kind === "human" &&
          this.readMembership(this.playerTokenHash(player.id) ?? "")?.role === "host",
      );
      if (host !== undefined) {
        const hash = this.playerTokenHash(host.id);
        if (hash !== null) this.sendCurrentMembership(hash);
      }
    }
  }

  private roomSnapshot(room: Room): RoomSocketMessage {
    return roomSocketContract.message.parse({
      type: "room.snapshot",
      room,
      presence: this.presence(room),
      serverNowMs: Date.now(),
    });
  }

  private sendSocketError(socket: WebSocket, error: RoomSocketError): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(roomSocketContract.message.parse({ type: "room.error", error })));
    }
  }

  private sendChat(
    tokenHash: string,
    rawText: string,
  ): "sent" | "unauthorized" | "rate_limited" | "muted" | "invalid_request" {
    const parsed = chatTextSchema.safeParse(rawText);
    if (!parsed.success) return "invalid_request";
    return this.withIndexTransaction(() => {
      const room = this.readRoom();
      const membership = this.readMembership(tokenHash);
      if (room === null || membership === null) return "unauthorized";
      const player = room.players.find((entry) => entry.id === membership.playerId);
      if (player?.kind !== "human") return "unauthorized";
      if ((this.ctx.storage.kv.get<string[]>(mutedKey) ?? []).includes(player.id)) return "muted";
      const now = Date.now();
      if (
        now - (this.ctx.storage.kv.get<number>(lastChatAtKey(player.id)) ?? -Infinity) <
        chatIntervalMs
      )
        return "rate_limited";
      const message = chatMessageSchema.parse({
        id: crypto.randomUUID(),
        senderId: player.id,
        senderName: player.name,
        text: parsed.data,
        sentAtMs: now,
      });
      this.ctx.storage.kv.put(chatKey, [...this.readChat(), message].slice(-chatHistoryLimit));
      this.ctx.storage.kv.put(lastChatAtKey(player.id), now);
      this.ctx.storage.kv.put(roomStorageKey, roomSchema.parse({ ...room, lastActivityAtMs: now }));
      return "sent";
    });
  }

  private async viewerMac(nonce: string): Promise<string> {
    const secret = this.ctx.storage.kv.get<string>(viewerSecretKey);
    if (secret === undefined) throw new Error("Missing viewer secret");
    const key = await crypto.subtle.importKey(
      "raw",
      hexToBytes(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(nonce)),
    );
    return bytesToHex(mac.slice(0, 16));
  }

  async issueViewerToken(): Promise<string | null> {
    await this.reconcileDeadlines();
    if (this.readRoom() === null) return null;
    const nonce = new Uint8Array(16);
    crypto.getRandomValues(nonce);
    const prefix = bytesToHex(nonce);
    return prefix + (await this.viewerMac(prefix));
  }

  async inspectReport(
    token: string,
    messageId: string,
  ): Promise<
    | { status: "found"; instanceId: string; message: ChatMessage; reporterHash: string }
    | { status: "not_found" | "unauthorized" | "message_not_found" }
  > {
    await this.reconcileDeadlines();
    const room = this.readRoom();
    if (room === null) return { status: "not_found" };
    const tokenHash = await hashMembershipToken(token);
    const membership = this.readMembership(tokenHash);
    const isPlayer =
      membership !== null && room.players.some((player) => player.id === membership.playerId);
    const isViewer =
      token.length === 64 && (await this.viewerMac(token.slice(0, 32))) === token.slice(32);
    if (!isPlayer && !isViewer) return { status: "unauthorized" };
    const message = this.readChat().find((entry) => entry.id === messageId);
    if (message === undefined || message.kind !== "player") return { status: "message_not_found" };
    return { status: "found", instanceId: room.instanceId, message, reporterHash: tokenHash };
  }

  async moderateMessage(
    instanceId: string,
    messageId: string,
    senderId: string,
    remove: boolean,
    mute: boolean,
  ): Promise<"applied" | "room_changed"> {
    await this.reconcileDeadlines();
    const room = this.readRoom();
    if (room === null || room.instanceId !== instanceId) return "room_changed";
    this.ctx.storage.transactionSync(() => {
      if (remove)
        this.ctx.storage.kv.put(
          chatKey,
          this.readChat().filter((message) => message.id !== messageId),
        );
      if (mute)
        this.ctx.storage.kv.put(mutedKey, [
          ...new Set([...(this.ctx.storage.kv.get<string[]>(mutedKey) ?? []), senderId]),
        ]);
    });
    if (remove) this.broadcastChat();
    return "applied";
  }

  private setReady(
    tokenHash: string,
    ready: boolean,
  ):
    | { status: "updated"; room: Room }
    | { status: "unchanged" }
    | { status: "not_found" }
    | { status: "unauthorized" }
    | { status: "already_started" } {
    return this.withIndexTransaction(() => {
      const room = this.readRoom();
      if (room === null) return { status: "not_found" };
      if (room.status !== "waiting") return { status: "already_started" };

      const membership = this.readMembership(tokenHash);
      if (membership === null) return { status: "unauthorized" };
      const player = room.players.find((entry) => entry.id === membership.playerId);
      if (player === undefined) return { status: "unauthorized" };
      if (player.ready === ready) return { status: "unchanged" };

      const updatedRoom = roomSchema.parse({
        ...room,
        lastActivityAtMs: Date.now(),
        players: room.players.map((entry) =>
          entry.id === player.id ? { ...entry, ready } : entry,
        ),
      });
      this.ctx.storage.kv.put(roomStorageKey, updatedRoom);
      return { status: "updated", room: updatedRoom };
    });
  }

  private setMode(
    tokenHash: string,
    mode: RoomMode,
  ):
    | { status: "updated"; room: Room }
    | { status: "unchanged" }
    | { status: "not_found" | "forbidden" | "already_started" } {
    return this.withIndexTransaction(() => {
      const room = this.readRoom();
      if (room === null) return { status: "not_found" };
      if (room.status !== "waiting") return { status: "already_started" };
      if (this.readMembership(tokenHash)?.role !== "host") return { status: "forbidden" };
      if (room.settings.mode === mode) return { status: "unchanged" };

      this.appendSystem(
        "mode_changed",
        `対局形式が${mode === "singles" ? "シングルス" : "ダブルス"}に変更されました`,
      );

      const updated = roomSchema.parse({
        ...room,
        settings: { ...room.settings, mode },
        publicUpdatedAtMs: nextPublicUpdateAt(room),
        lastActivityAtMs: Date.now(),
        players: room.players.map((player) =>
          player.kind === "human" ? { ...player, ready: false } : player,
        ),
      });
      this.ctx.storage.kv.put(roomStorageKey, updated);
      return { status: "updated", room: updated };
    });
  }

  private updateCpu(
    tokenHash: string,
    command: CpuCommand,
  ):
    | { status: "updated"; room: Room }
    | { status: "unchanged" }
    | { status: "not_found" | "forbidden" | "already_started" | "room_full" | "cpu_not_found" } {
    return this.withIndexTransaction(() => {
      const room = this.readRoom();
      if (room === null) return { status: "not_found" };
      if (room.status !== "waiting") return { status: "already_started" };
      if (this.readMembership(tokenHash)?.role !== "host") return { status: "forbidden" };

      if (command.type === "room.cpu.add") {
        if (room.players.length >= 4) return { status: "room_full" };
        const used = new Set(
          room.players.filter((player) => player.kind === "cpu").map((player) => player.name),
        );
        const number = [1, 2, 3].find((value) => !used.has(`CPU ${value}`));
        if (number === undefined) return { status: "room_full" };
        this.appendSystem("joined", `CPU Lv${command.level}が入室しました`);
        const updated = roomSchema.parse({
          ...room,
          publicUpdatedAtMs: nextPublicUpdateAt(room),
          lastActivityAtMs: Date.now(),
          players: [
            ...room.players,
            {
              id: crypto.randomUUID(),
              name: `CPU ${number}`,
              kind: "cpu",
              level: command.level,
              ready: true,
              ...(isFourShogiRoom(room) ? { side: null } : { color: null }),
              reconnectDeadline: null,
            },
          ],
        });
        this.ctx.storage.kv.put(roomStorageKey, updated);
        return { status: "updated", room: updated };
      }

      const cpu = room.players.find((player) => player.id === command.playerId);
      if (cpu?.kind !== "cpu") return { status: "cpu_not_found" };
      if (command.type === "room.cpu.remove") {
        this.recordDeparture(cpu);
        const updated = roomSchema.parse({
          ...room,
          publicUpdatedAtMs: nextPublicUpdateAt(room),
          lastActivityAtMs: Date.now(),
          players: room.players.filter((player) => player.id !== cpu.id),
        });
        this.ctx.storage.kv.put(roomStorageKey, updated);
        return { status: "updated", room: updated };
      }
      if (cpu.level === command.level) return { status: "unchanged" };
      const updated = roomSchema.parse({
        ...room,
        publicUpdatedAtMs: nextPublicUpdateAt(room),
        lastActivityAtMs: Date.now(),
        players: room.players.map((player) =>
          player.id === cpu.id ? { ...cpu, level: command.level } : player,
        ),
      });
      this.ctx.storage.kv.put(roomStorageKey, updated);
      return { status: "updated", room: updated };
    });
  }

  private startGame(
    tokenHash: string,
  ):
    | { status: "started"; room: Room }
    | { status: "not_found" | "unauthorized" | "forbidden" | "not_ready" | "already_started" } {
    return this.withIndexTransaction(() => {
      const room = this.readRoom();
      if (room === null) return { status: "not_found" };
      if (room.status !== "waiting") return { status: "already_started" };

      const membership = this.readMembership(tokenHash);
      if (membership === null) return { status: "unauthorized" };
      if (membership.role !== "host") return { status: "forbidden" };
      if (
        room.players.length !== 4 ||
        room.players.some((player) => {
          if (player.kind === "cpu") return false;
          const hash = this.playerTokenHash(player.id);
          return !player.ready || hash === null || !this.hasOpenConnection(hash);
        })
      ) {
        return { status: "not_ready" };
      }

      if (isFourShogiRoom(room)) return { status: "started", room: this.startShogiGame(room) };
      const assignments = shuffledAssignments(colors);
      const startedAtMs = Date.now();
      const matchId = crypto.randomUUID();
      const startedRoom = this.parseReversiRoom({
        ...room,
        status: "playing",
        eliminations: [],
        publicUpdatedAtMs: nextPublicUpdateAt(room),
        lastActivityAtMs: startedAtMs,
        lastRound: null,
        players: room.players.map((player, index) => ({
          ...player,
          ready: player.kind === "cpu" ? true : false,
          color: assignments[index],
        })),
        game: createInitialState(room.settings.mode),
        clock: createClock(startedAtMs),
      });
      this.ctx.storage.kv.put(roomStorageKey, startedRoom);
      this.ctx.storage.kv.put(
        replayKey,
        roundReplaySchema.parse({
          id: matchId,
          initial: startedRoom.game,
          steps: [],
        }),
      );
      if (startedRoom.status !== "playing") throw new Error("Game did not start");
      this.ctx.storage.kv.put(matchStartKey, {
        id: matchId,
        roomId: startedRoom.id,
        instanceId: startedRoom.instanceId,
        startedAtMs,
        settings: startedRoom.settings,
        participants: startedRoom.players.map((player, seat) => ({
          id: player.id,
          name: this.playerLabel(player),
          color: player.color,
          seat,
          ...(player.kind === "cpu"
            ? { kind: "cpu" as const, level: player.level }
            : {
                kind: "human" as const,
                accountId: this.storedAccount(player.id)?.accountId ?? null,
              }),
        })),
      } satisfies MatchStart);
      return { status: "started", room: startedRoom };
    });
  }

  private placeStone(
    tokenHash: string,
    action: FourReversiAction,
  ):
    | { status: "placed"; room: Room | null }
    | {
        status:
          | "not_found"
          | "unauthorized"
          | "game_not_started"
          | "game_finished"
          | "not_your_turn"
          | "invalid_move"
          | "already_eliminated"
          | "time_expired";
      } {
    return this.withIndexTransaction(() => {
      const room = this.readRoom();
      if (room === null) return { status: "not_found" };
      if (isFourShogiRoom(room)) return { status: "invalid_move" };
      if (room.status === "waiting")
        return { status: room.lastRound ? "game_finished" : "game_not_started" };
      if (isClockExpired(room.clock, Date.now())) return { status: "time_expired" };

      const membership = this.readMembership(tokenHash);
      if (membership === null) return { status: "unauthorized" };
      const player = room.players.find((entry) => entry.id === membership.playerId);
      if (player !== undefined && room.game.eliminatedColors.includes(player.color)) {
        return { status: "already_eliminated" };
      }
      if (player?.color !== room.game.turn) return { status: "not_your_turn" };
      const result = applyAction(room.game, action);
      if (!result.ok) return { status: "invalid_move" };
      this.recordReplayStep(
        { type: "place", color: room.game.turn, position: action.position },
        result,
      );
      const at = Date.now();
      const updatedRoom =
        result.state.status === "finished"
          ? this.finishGame(room, result.state, at)
          : roomSchema.parse({
              ...room,
              game: result.state,
              clock: advanceClock(room.clock, room.game.turn, result.state.turn, at, true),
              lastActivityAtMs: at,
            });
      if (updatedRoom !== null) this.ctx.storage.kv.put(roomStorageKey, updatedRoom);
      return { status: "placed", room: updatedRoom };
    });
  }

  private resign(tokenHash: string):
    | { status: "resigned"; room: Room | null }
    | {
        status:
          | "not_found"
          | "unauthorized"
          | "game_not_started"
          | "game_finished"
          | "not_your_turn"
          | "already_eliminated"
          | "time_expired";
      } {
    return this.withIndexTransaction(() => {
      const room = this.readRoom();
      if (room === null) return { status: "not_found" };
      if (isFourShogiRoom(room)) return this.resignShogi(room, tokenHash);
      if (room.status === "waiting")
        return { status: room.lastRound ? "game_finished" : "game_not_started" };
      if (isClockExpired(room.clock, Date.now())) return { status: "time_expired" };
      const membership = this.readMembership(tokenHash);
      if (membership === null) return { status: "unauthorized" };
      const player = room.players.find((entry) => entry.id === membership.playerId);
      if (player === undefined) return { status: "unauthorized" };
      if (room.game.eliminatedColors.includes(player.color)) {
        return { status: "already_eliminated" };
      }
      if (room.game.turn !== player.color) return { status: "not_your_turn" };
      const result = eliminateColor(room.game, player.color);
      if (!result.ok) throw new Error("Could not resign current player");
      this.recordElimination(room, player.color, "resigned", result);
      const at = Date.now();
      const updated =
        result.state.status === "finished"
          ? this.finishGame(room, result.state, at)
          : roomSchema.parse({
              ...room,
              game: result.state,
              clock: advanceClock(room.clock, room.game.turn, result.state.turn, at, true),
              lastActivityAtMs: at,
            });
      if (updated !== null) this.ctx.storage.kv.put(roomStorageKey, updated);
      return { status: "resigned", room: updated };
    });
  }

  private rejectAction(socket: WebSocket, error: RoomSocketError): void {
    this.sendSocketError(socket, error);
    const room = this.readRoom();
    if (room !== null && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(this.roomSnapshot(room)));
    }
  }

  async fetch(request: Request): Promise<Response> {
    const query = roomSocketContract.query.safeParse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    if (!query.success) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    await this.reconcileDeadlines();
    const room = this.readRoom();
    if (room === null) {
      return Response.json(roomSocketContract.error.parse({ error: "not_found" }), { status: 404 });
    }
    if (query.data.instanceId !== undefined && room.instanceId !== query.data.instanceId) {
      return Response.json({ error: "room_changed" }, { status: 410 });
    }

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return Response.json(roomSocketContract.error.parse({ error: "upgrade_required" }), {
        status: 426,
      });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify(this.roomSnapshot(room)));
    server.send(JSON.stringify(this.chatSnapshot()));

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string" || message.length > 8192) {
      this.sendSocketError(socket, "invalid_request");
      return;
    }

    let body: unknown;
    try {
      body = JSON.parse(message);
    } catch {
      this.sendSocketError(socket, "invalid_request");
      return;
    }

    const parsed = roomSocketContract.clientMessage.safeParse(body);
    if (!parsed.success) {
      this.sendSocketError(socket, "invalid_request");
      return;
    }

    try {
      await this.reconcileDeadlines();
      if (this.readRoom() === null) {
        this.sendSocketError(socket, "not_found");
        return;
      }
      if (parsed.data.type === "room.auth") {
        const tokenHash = await hashMembershipToken(parsed.data.token);
        const existing: unknown = socket.deserializeAttachment();
        if (
          typeof existing === "object" &&
          existing !== null &&
          "tokenHash" in existing &&
          existing.tokenHash !== tokenHash
        ) {
          this.sendSocketError(socket, "unauthorized");
          return;
        }
        const result = await this.getRoomMembership(tokenHash);
        if (result.status !== "found") {
          socket.serializeAttachment(null);
          this.sendSocketError(
            socket,
            result.status === "not_found" ? "not_found" : "unauthorized",
          );
          return;
        }

        socket.serializeAttachment({ tokenHash });
        this.ctx.storage.kv.delete(disconnectedAtKey(result.membership.playerId));
        const room = this.readRoom();
        const player = room?.players.find((entry) => entry.id === result.membership.playerId);
        if (player !== undefined && player.reconnectDeadline !== null) {
          const updated = this.withIndexTransaction(() => {
            const current = this.readRoom();
            if (current === null) return null;
            const next = roomSchema.parse({
              ...current,
              players: current.players.map((entry) =>
                entry.id === player.id ? { ...entry, reconnectDeadline: null } : entry,
              ),
            });
            this.ctx.storage.kv.put(roomStorageKey, next);
            return next;
          });
          if (updated !== null) {
            await this.syncAlarm(updated);
          }
        }
        const connectedRoom = this.readRoom();
        if (connectedRoom !== null) this.broadcastRoom(connectedRoom);
        socket.send(
          JSON.stringify(
            roomSocketContract.message.parse({
              type: "room.authenticated",
              membership: result.membership,
            }),
          ),
        );
        return;
      }

      const attachment: unknown = socket.deserializeAttachment();
      const tokenHash =
        typeof attachment === "object" && attachment !== null && "tokenHash" in attachment
          ? membershipTokenSchema.safeParse(attachment.tokenHash)
          : null;
      if (tokenHash === null || !tokenHash.success) {
        this.sendSocketError(socket, "unauthorized");
        return;
      }

      if (parsed.data.type === "room.ready.set") {
        const result = this.setReady(tokenHash.data, parsed.data.ready);
        if (result.status === "updated") {
          this.broadcastRoom(result.room);
        } else if (result.status === "unchanged") {
          const room = this.readRoom();
          if (room !== null) {
            socket.send(JSON.stringify(this.roomSnapshot(room)));
          }
        } else {
          this.rejectAction(socket, result.status);
        }
        return;
      }

      if (parsed.data.type === "room.chat.send") {
        const status = this.sendChat(tokenHash.data, parsed.data.text);
        if (status === "sent") this.broadcastChat();
        else
          socket.send(
            JSON.stringify(
              roomSocketContract.message.parse({ type: "room.chat.error", error: status }),
            ),
          );
        return;
      }

      if (parsed.data.type === "room.three-player-attack.set") {
        const result = this.setThreePlayerAttack(tokenHash.data, parsed.data.prohibited);
        if (result.status === "updated") this.broadcastRoom(result.room);
        else if (result.status === "unchanged") {
          const room = this.readRoom();
          if (room) socket.send(JSON.stringify(this.roomSnapshot(room)));
        } else this.rejectAction(socket, result.status);
        return;
      }
      if (parsed.data.type === "room.mode.set") {
        const result = this.setMode(tokenHash.data, parsed.data.mode);
        if (result.status === "updated") this.broadcastRoom(result.room);
        else if (result.status === "unchanged") {
          const room = this.readRoom();
          if (room !== null) socket.send(JSON.stringify(this.roomSnapshot(room)));
        } else this.rejectAction(socket, result.status);
        return;
      }

      if (
        parsed.data.type === "room.cpu.add" ||
        parsed.data.type === "room.cpu.remove" ||
        parsed.data.type === "room.cpu.level.set"
      ) {
        const result = this.updateCpu(tokenHash.data, parsed.data);
        if (result.status === "updated") this.broadcastRoom(result.room);
        else if (result.status === "unchanged") {
          const room = this.readRoom();
          if (room !== null) socket.send(JSON.stringify(this.roomSnapshot(room)));
        } else this.rejectAction(socket, result.status);
        return;
      }

      if (parsed.data.type === "room.game.start") {
        const result = this.startGame(tokenHash.data);
        if (result.status === "started") {
          await this.syncAlarm(result.room);
          this.broadcastRoom(result.room);
        } else this.rejectAction(socket, result.status);
        return;
      }

      if (parsed.data.type === "room.game.draw.set") {
        const result = this.setShogiDrawProposal(tokenHash.data, parsed.data);
        if (result.status === "updated") {
          await this.syncAlarm(result.room);
          if (result.room === null) this.closeSockets();
          else this.broadcastRoom(result.room);
        } else if (result.status === "unchanged") {
          if (result.room) socket.send(JSON.stringify(this.roomSnapshot(result.room)));
        } else if (result.status === "time_expired") {
          await this.reconcileDeadlines();
          this.rejectAction(socket, result.status);
        } else this.rejectAction(socket, result.status);
        return;
      }

      if (parsed.data.type === "room.game.resign") {
        const result = this.resign(tokenHash.data);
        if (result.status === "resigned") {
          await this.syncAlarm(result.room);
          if (result.room === null) this.closeSockets();
          else this.broadcastRoom(result.room);
        } else if (result.status === "time_expired") {
          await this.reconcileDeadlines();
          this.rejectAction(socket, result.status);
        } else this.rejectAction(socket, result.status);
        return;
      }

      const command = parsed.data;
      const result =
        command.action.type === "placeStone"
          ? this.placeStone(tokenHash.data, command.action)
          : this.playShogi(
              tokenHash.data,
              command.action,
              command.roundId,
              command.positionRevision,
            );
      if (result.status === "placed") {
        await this.syncAlarm(result.room);
        if (result.room === null) this.closeSockets();
        else this.broadcastRoom(result.room);
      } else if (result.status === "time_expired") {
        await this.reconcileDeadlines();
        this.rejectAction(socket, result.status);
      } else this.rejectAction(socket, result.status);
    } catch {
      this.sendSocketError(socket, "internal_error");
    }
  }

  private async socketGone(socket: WebSocket): Promise<void> {
    const attachment: unknown = socket.deserializeAttachment();
    if (
      typeof attachment !== "object" ||
      attachment === null ||
      !("tokenHash" in attachment) ||
      typeof attachment.tokenHash !== "string"
    )
      return;
    const tokenHash = attachment.tokenHash;
    if (this.hasOpenConnection(tokenHash, socket)) return;
    await this.reconcileDeadlines();
    if (this.hasOpenConnection(tokenHash, socket)) return;
    const membership = this.readMembership(tokenHash);
    const room = this.readRoom();
    if (membership === null || room === null) return;
    const player = room.players.find((entry) => entry.id === membership.playerId);
    if (
      player !== undefined &&
      this.ctx.storage.kv.get(disconnectedAtKey(player.id)) === undefined
    ) {
      this.ctx.storage.kv.put(disconnectedAtKey(player.id), Date.now());
    }
    if (
      player === undefined ||
      !this.isHumanParticipant(player) ||
      player.reconnectDeadline !== null
    ) {
      this.broadcastRoom(room);
      return;
    }
    const updated = this.withIndexTransaction(() => {
      const current = this.readRoom();
      if (current === null) return null;
      this.ctx.storage.kv.put(disconnectedAtKey(player.id), Date.now());
      const next = roomSchema.parse({
        ...current,
        players: current.players.map((entry) =>
          entry.id === player.id
            ? { ...entry, reconnectDeadline: Date.now() + reconnectGraceMs }
            : entry,
        ),
      });
      this.ctx.storage.kv.put(roomStorageKey, next);
      return next;
    });
    if (updated !== null) {
      await this.syncAlarm(updated);
      this.broadcastRoom(updated);
    }
  }

  async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    try {
      socket.close(code, reason);
    } catch {
      // 切断済みの接続は、そのまま無視します。
    }
    await this.socketGone(socket);
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    try {
      socket.close(1011, "Connection error");
    } catch {
      // 切断済みの接続は、そのまま無視します。
    }
    await this.socketGone(socket);
  }
}
