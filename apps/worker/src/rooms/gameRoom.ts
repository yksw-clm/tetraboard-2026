import { isGomokuRoom, type GomokuRoom } from "@tetraboard/protocol";
import type { PendingMatch as PendingGomokuMatch } from "./gomokuMatchStore";
import { roomInteractionIntervalMs, type RoomStampNotification } from "@tetraboard/protocol";
import { isShogiRoom, type ShogiRoom, fourShogiActionSchema } from "@tetraboard/protocol";
import {
  pendingStandardShogiMatchPrefix,
  standardShogiMatchStartKey,
  type PendingStandardShogiMatch,
} from "./shogiMatchStore";
import { isReversiRoom, type ReversiRoom } from "@tetraboard/protocol";
import type { PendingMatch as PendingReversiMatch } from "./reversiMatchStore";
import { gameCapacity } from "@tetraboard/protocol/games";
import { nextDueRoomDeadline, earliestAlarmAt } from "./roomDeadlines";
import { roomFormationAnalysis, formationAnalysisTag } from "./fourShogiFormationAnalysis";
import {
  analyticsActiveKey,
  analyticsPendingPrefix,
  analyticsPlayerKey,
  writeAnalyticsMatch,
  type AnalyticsIdentity,
  type AnalyticsMatch,
  type AnalyticsJob,
} from "../analytics/store";
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
  roomSocketContract,
  isFourShogiRoom,
  type FourShogiRoom,
  type FourReversiRoom,
  type Room,
  type RoomMembership,
  type RoomMode,
  type RoomTimeControl,
  type RoomPublicMetadata,
  type RoomSocketClientMessage,
  type RoomSocketMessage,
  type ChatMessage,
  type ChatEntry,
  type RoomPresence,
  type SystemChatMessage,
} from "@tetraboard/protocol";
import { gameProgress, unreachable, type AnyProgress, type ProgressFor } from "./gameProgress";
import type { ShogiCpuJob } from "./fourShogiProgress";
import {
  roomStorageKey,
  replayKey,
  shogiCpuJobKey,
  cpuMoveDelayMs,
  nextPublicUpdateAt,
} from "./progressHelpers";
import {
  advanceShogiMatchSave,
  pendingShogiMatchPrefix,
  shogiMatchStartKey,
  type PendingShogiMatch,
} from "./shogiMatchStore";
import { profileAvatarUrl } from "../accounts/auth";
import { releaseReservation, type AccountAdmission } from "../accounts/roomAccounts";
import { DurableObject } from "cloudflare:workers";
import { isClockExpired } from "./clock";
import { writeRoomIndex, type PendingRoomIndex } from "./roomIndex";
import { matchStartKey, pendingMatchPrefix, writeMatch, type PendingMatch } from "./matchStore";

const accountKey = (playerId: string) => `seat-account:${playerId}`;
const cancelledAdmissionKey = (operationId: string) => `cancelled-admission:${operationId}`;
const accountCleanupKey = "account-cleanups";
type StoredAccountSeat = AccountAdmission & { occupying: boolean };
type AccountCleanup = { reservation: AccountAdmission; releaseAvatar: boolean; retryAtMs: number };
const indexRevisionKey = "room-index-revision";
const pendingIndexKey = "room-index-pending";
const chatKey = "chat";
const mutedKey = "chat-muted";
const viewerSecretKey = "viewer-secret";
const disconnectedAtKey = (playerId: string) => `disconnected-at:${playerId}`;
const lastChatAtKey = (playerId: string) => `last-chat-at:${playerId}`;
const membershipStorageKey = (tokenHash: string) => `membership:${tokenHash}`;
const playerTokenKey = (playerId: string) => `player-token:${playerId}`;
const reconnectGraceMs = 30_000;
const idleMs = 24 * 60 * 60 * 1000;
const stampTag = "room-stamps-v1";
const departedKey = (playerId: string) => `departed:${playerId}`;
type RoomSocketError = Extract<RoomSocketMessage, { type: "room.error" }>["error"];
type CpuCommand = Extract<
  RoomSocketClientMessage,
  { type: "room.cpu.add" | "room.cpu.remove" | "room.cpu.level.set" }
>;

function currentCpu(room: Room): Extract<Room["players"][number], { kind: "cpu" }> | null {
  if (room.status !== "playing") return null;
  const player =
    isFourShogiRoom(room) || isShogiRoom(room)
      ? room.players.find((entry) => entry.side === room.game.turn)
      : room.players.find((entry) => entry.color === room.game.turn);
  return player?.kind === "cpu" ? player : null;
}

async function hashMembershipToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join(
    "",
  );
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
  private readonly progressDependencies = {
    storage: this.ctx.storage,
    membership: (hash: string) => this.readMembership(hash),
    accountId: (playerId: string) => this.storedAccount(playerId)?.accountId ?? null,
  };
  private readonly reversiProgress = gameProgress["four-reversi"].create(this.progressDependencies);
  private readonly gomokuProgress = gameProgress.gomoku.create(this.progressDependencies);
  private readonly standardProgress = gameProgress.reversi.create(this.progressDependencies);
  private readonly shogiProgress = gameProgress["four-shogi"].create(this.progressDependencies);
  private readonly standardShogiProgress = gameProgress.shogi.create(this.progressDependencies);
  private analyticsFlush: Promise<void> | null = null;

  private pendingAnalytics() {
    return new Map(this.ctx.storage.kv.list<AnalyticsJob>({ prefix: analyticsPendingPrefix }));
  }

  private startAnalyticsMatch(id: string, room: Room, at: number) {
    const record: AnalyticsMatch = {
      id,
      game: room.settings.game,
      mode: room.settings.mode ?? "standard",
      startedAtMs: at,
      endedAtMs: null,
      status: "playing",
      cpuCount: room.players.filter((p) => p.kind === "cpu").length,
      participants: room.players
        .filter((p) => p.kind === "human")
        .map((p) => {
          const identity = this.ctx.storage.kv.get<AnalyticsIdentity>(analyticsPlayerKey(p.id));
          return {
            playerId: p.id,
            visitorId: identity?.visitorId ?? null,
            accountId: this.storedAccount(p.id)?.accountId ?? null,
            isTest: identity?.isTest ?? false,
          };
        }),
    };
    this.ctx.storage.kv.put(analyticsActiveKey, record);
    this.ctx.storage.kv.put(analyticsPendingPrefix + id, {
      record,
      revision: 1,
      retryAtMs: Date.now(),
    } satisfies AnalyticsJob);
  }

  private endAnalyticsMatch(status: "completed" | "abandoned", at: number) {
    const active = this.ctx.storage.kv.get<AnalyticsMatch>(analyticsActiveKey);
    if (!active) return;
    const record = { ...active, status, endedAtMs: at };
    this.ctx.storage.kv.delete(analyticsActiveKey);
    this.ctx.storage.kv.put(analyticsPendingPrefix + record.id, {
      record,
      revision: 2,
      retryAtMs: Date.now(),
    } satisfies AnalyticsJob);
  }

  private async flushAnalytics(): Promise<void> {
    if (this.analyticsFlush) return this.analyticsFlush;
    const flush = async () => {
      for (let pass = 0; pass < 16; pass++) {
        const next = [...this.pendingAnalytics()].find(([, job]) => job.retryAtMs <= Date.now());
        if (!next) break;
        const [key, job] = next;
        try {
          await writeAnalyticsMatch(this.env.APP_DB, job.record);
          this.ctx.storage.transactionSync(() => {
            if (this.ctx.storage.kv.get<AnalyticsJob>(key)?.revision === job.revision)
              this.ctx.storage.kv.delete(key);
          });
        } catch {
          this.ctx.storage.transactionSync(() => {
            if (this.ctx.storage.kv.get<AnalyticsJob>(key)?.revision === job.revision)
              this.ctx.storage.kv.put(key, { ...job, retryAtMs: Date.now() + 5000 });
          });
          console.error("Analytics save will be retried");
          break;
        }
      }
      await this.syncAlarm(this.readRoom());
    };
    this.analyticsFlush = flush().finally(() => {
      this.analyticsFlush = null;
    });
    return this.analyticsFlush;
  }

  private pendingMatches() {
    return new Map(
      this.ctx.storage.kv.list<PendingMatch | PendingReversiMatch | PendingGomokuMatch>({
        prefix: pendingMatchPrefix,
      }),
    );
  }
  private pendingShogiMatches() {
    return new Map([
      ...this.ctx.storage.kv.list<PendingShogiMatch | PendingStandardShogiMatch>({
        prefix: pendingShogiMatchPrefix,
      }),
      ...this.ctx.storage.kv.list<PendingShogiMatch | PendingStandardShogiMatch>({
        prefix: pendingStandardShogiMatchPrefix,
      }),
    ]);
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
            (cursor) =>
              job.record.settings.game === "shogi"
                ? this.standardShogiProgress.store().replayEvents(job.record.id, cursor)
                : this.shogiProgress.store().replayEvents(job.record.id, cursor),
            "formationUsage" in job ? job.formationUsage : undefined,
          );
          this.ctx.storage.transactionSync(() => {
            if (progress)
              this.ctx.storage.kv.put(key, { ...job, progress, retryAtMs: Date.now() + 1 });
            else {
              this.ctx.storage.kv.delete(key);
              const room = this.readRoom();
              const keep = Boolean(
                room &&
                (isFourShogiRoom(room) || isShogiRoom(room)) &&
                room.status === "waiting" &&
                room.lastRound?.roundId === job.record.id,
              );
              (job.record.settings.game === "shogi"
                ? this.standardShogiProgress.store()
                : this.shogiProgress.store()
              ).releaseArchive(job.record.id, keep);
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
        (room.players.some(
          (player) =>
            player.id === admission.playerId &&
            player.kind === "human" &&
            player.avatarUrl === profileAvatarUrl(admission.avatarKey),
        ) ||
          room.lastRound?.players.some(
            (player) =>
              player.id === admission.playerId &&
              player.appearance?.kind === "human" &&
              player.appearance.avatarUrl === profileAvatarUrl(admission.avatarKey),
          ));
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
    if (isFourShogiRoom(room)) this.shogiProgress.normalize(room, saved);
    else if (isReversiRoom(room)) this.standardProgress.normalize(room, saved);
    else if (!isShogiRoom(room) && !isGomokuRoom(room)) this.reversiProgress.normalize(room, saved);
    return room;
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
    this.ctx.storage.kv.delete(analyticsPlayerKey(player.id));
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

  private releaseResultAvatars(room: Room, retainedIds: Set<string>): void {
    for (const player of room.lastRound?.players ?? []) {
      if (!retainedIds.has(player.id)) this.releaseAccount(player.id, true);
    }
  }

  private closeRoom(): void {
    const room = this.readRoom();
    if (room) this.releaseResultAvatars(room, new Set());
    this.endAnalyticsMatch("abandoned", Date.now());
    for (const player of room?.players ?? []) {
      this.ctx.storage.kv.delete(analyticsPlayerKey(player.id));
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
    this.ctx.storage.kv.delete(standardShogiMatchStartKey);
    this.ctx.storage.kv.delete(chatKey);
    this.ctx.storage.kv.delete(mutedKey);
    this.ctx.storage.kv.delete(viewerSecretKey);
    this.ctx.storage.kv.delete(shogiCpuJobKey);
    this.ctx.storage.kv.delete("standard-shogi-cpu-job");
    if (room && isFourShogiRoom(room)) this.shogiProgress.store().clear();
    if (room && isShogiRoom(room)) this.standardShogiProgress.store().clear();
  }

  private applyProgress(result: ProgressFor<"gomoku">): GomokuRoom | null;
  private applyProgress(result: ProgressFor<"shogi">): ShogiRoom | null;
  private applyProgress(result: ProgressFor<"reversi">): ReversiRoom | null;
  private applyProgress(result: ProgressFor<"four-reversi">): FourReversiRoom | null;
  private applyProgress(result: ProgressFor<"four-shogi">): FourShogiRoom | null;
  private applyProgress(result: AnyProgress): Room | null;
  private applyProgress(result: AnyProgress): Room | null {
    switch (result.kind) {
      case "rejected":
        throw new Error(`Rejected progress: ${result.error}`);
      case "unchanged":
      case "playing":
        return result.room;
      case "finished": {
        this.endAnalyticsMatch("completed", result.at);
        switch (result.gameId) {
          case "gomoku": {
            const lastRound = this.gomokuProgress.finalize(result);
            const players = this.rematchPlayers(result.room.players, result.at);
            return players === null
              ? null
              : this.gomokuProgress.waiting({ ...result, lastRound }, players);
          }
          case "reversi": {
            const lastRound = this.standardProgress.finalize(result);
            const players = this.rematchPlayers(result.room.players, result.at);
            return players === null
              ? null
              : this.standardProgress.waiting({ ...result, lastRound }, players);
          }
          case "four-reversi": {
            const lastRound = this.reversiProgress.finalize(result);
            const players = this.rematchPlayers(result.room.players, result.at);
            return players === null
              ? null
              : this.reversiProgress.waiting({ ...result, lastRound }, players);
          }
          case "four-shogi": {
            const lastRound = this.shogiProgress.finalize(result);
            const players = this.rematchPlayers(result.room.players, result.at);
            return players === null
              ? null
              : this.shogiProgress.waiting({ ...result, lastRound }, players);
          }
          case "shogi": {
            const lastRound = this.standardShogiProgress.finalize(result);
            const players = this.rematchPlayers(result.room.players, result.at);
            return players === null
              ? null
              : this.standardShogiProgress.waiting({ ...result, lastRound }, players);
          }
          default:
            return unreachable(result);
        }
      }
      default:
        return unreachable(result);
    }
  }

  private rematchPlayers<P extends Room["players"][number]>(seats: P[], at: number): P[] | null {
    const players = seats.filter((player) => {
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
    for (const player of seats) {
      if (player.kind !== "human" || players.includes(player)) continue;
      this.recordDeparture(player);
      // 前局の結果が表示される間は、退室者の画像参照だけを保持します。
      this.releaseAccount(player.id, false);
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
    return ordered.map((player) => ({
      ...player,
      ready: player.kind === "cpu",
      reconnectDeadline:
        player.kind === "cpu" || this.hasOpenConnection(this.playerTokenHash(player.id)!)
          ? null
          : this.ctx.storage.kv.get<number>(disconnectedAtKey(player.id))! + reconnectGraceMs,
    }));
  }

  private playGomoku(
    tokenHash: string,
    command: import("@tetraboard/protocol").GameActionCommandFor<"gomoku">,
  ): { status: "placed"; room: Room | null } | { status: RoomSocketError } {
    return this.withIndexTransaction(() => {
      const room = this.readRoom();
      if (!room) return { status: "not_found" };
      if (!isGomokuRoom(room)) return { status: "invalid_move" };
      const result = this.gomokuProgress.play(room, tokenHash, command);
      if (result.kind === "rejected") return { status: result.error };
      const updated = this.applyProgress(result);
      if (updated) this.ctx.storage.kv.put(roomStorageKey, updated);
      return { status: "placed", room: updated };
    });
  }
  private playShogi(
    tokenHash: string,
    command: import("@tetraboard/protocol").GameActionCommandFor<"shogi">,
  ): { status: "placed"; room: Room | null } | { status: RoomSocketError } {
    return this.withIndexTransaction(() => {
      const room = this.readRoom();
      if (!room) return { status: "not_found" };
      if (!isFourShogiRoom(room) && !isShogiRoom(room)) return { status: "invalid_move" };
      const parsedAction = fourShogiActionSchema.safeParse(command.action);
      if (isFourShogiRoom(room) && !parsedAction.success) return { status: "invalid_move" };
      const result = isShogiRoom(room)
        ? this.standardShogiProgress.play(room, tokenHash, command)
        : this.shogiProgress.play(room, tokenHash, { ...command, action: parsedAction.data! });
      if (result.kind === "rejected") return { status: result.error };
      const updated = this.applyProgress(result);
      if (updated) this.ctx.storage.kv.put(roomStorageKey, updated);
      return { status: "placed", room: updated };
    });
  }
  private setShogiDrawProposal(
    tokenHash: string,
    command: Extract<RoomSocketClientMessage, { type: "room.game.draw.set" }>,
  ): { status: "updated" | "unchanged"; room: Room | null } | { status: RoomSocketError } {
    return this.withIndexTransaction(() => {
      const room = this.readRoom();
      if (!room) return { status: "not_found" };
      if (!isFourShogiRoom(room) && !isShogiRoom(room)) return { status: "invalid_request" };
      const result = isShogiRoom(room)
        ? this.standardShogiProgress.draw(room, tokenHash, command)
        : this.shogiProgress.draw(room, tokenHash, command);
      if (result.kind === "rejected") return { status: result.error };
      if (result.kind === "unchanged") return { status: "unchanged", room: result.room };
      let updated = this.applyProgress(result);
      if (updated && isShogiRoom(updated) && updated.status === "playing")
        updated = this.applyProgress(this.standardShogiProgress.cpuDraw(updated, Date.now()));
      if (updated) this.ctx.storage.kv.put(roomStorageKey, updated);
      return { status: "updated", room: updated };
    });
  }

  private declareShogi(
    tokenHash: string,
    command: Extract<RoomSocketClientMessage, { type: "room.game.declare" }>,
  ): { status: "updated"; room: Room | null } | { status: RoomSocketError } {
    return this.withIndexTransaction(() => {
      const room = this.readRoom();
      if (!room) return { status: "not_found" };
      if (!isShogiRoom(room)) return { status: "invalid_request" };
      const result = this.standardShogiProgress.declare(room, tokenHash, command);
      if (result.kind === "rejected") return { status: result.error };
      const updated = this.applyProgress(result);
      if (updated) this.ctx.storage.kv.put(roomStorageKey, updated);
      return { status: "updated", room: updated };
    });
  }
  private setGomokuForbidden(
    tokenHash: string,
    enabled: boolean,
  ):
    | { status: "updated"; room: Room }
    | { status: "unchanged" | "not_found" | "forbidden" | "already_started" | "invalid_request" } {
    return this.withIndexTransaction(() => {
      const room = this.readRoom();
      if (!room) return { status: "not_found" };
      if (!isGomokuRoom(room)) return { status: "invalid_request" };
      if (room.status !== "waiting") return { status: "already_started" };
      if (this.readMembership(tokenHash)?.role !== "host") return { status: "forbidden" };
      if (room.settings.forbiddenRules === enabled) return { status: "unchanged" };
      const updated: GomokuRoom = {
        ...room,
        settings: { ...room.settings, forbiddenRules: enabled },
        players: room.players.map((p) => (p.kind === "cpu" ? p : { ...p, ready: false })),
        publicUpdatedAtMs: nextPublicUpdateAt(room),
        lastActivityAtMs: Date.now(),
      };
      this.ctx.storage.kv.put(roomStorageKey, updated);
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
      const updated = this.shogiProgress.settings(room, prohibited);
      this.ctx.storage.kv.put(roomStorageKey, updated);
      return { status: "updated", room: updated };
    });
  }

  async getShogiReplay(
    instanceId: string,
    roundId: string,
    cursor: number,
  ): Promise<
    | {
        status: "found";
        page:
          | import("@tetraboard/protocol").FourShogiReplayPage
          | import("@tetraboard/protocol").ShogiReplayPage;
      }
    | { status: "not_found" | "room_changed" }
  > {
    await this.reconcileDeadlines();
    const room = this.readRoom();
    if (!room) return { status: "not_found" };
    if (room.instanceId !== instanceId) return { status: "room_changed" };
    if (
      (!isFourShogiRoom(room) && !isShogiRoom(room)) ||
      room.status !== "waiting" ||
      room.lastRound?.roundId !== roundId
    )
      return { status: "not_found" };
    const page = (
      isShogiRoom(room) ? this.standardShogiProgress.store() : this.shogiProgress.store()
    ).getPage(instanceId, roundId, cursor);
    return page ? { status: "found", page } : { status: "not_found" };
  }

  private publicMetadata(
    room: Room,
  ): RoomPublicMetadata & { instanceId: string; hostPlayerId: string | null } {
    const host = room.players.find((player) => {
      if (player.kind !== "human") return false;
      const tokenHash = this.playerTokenHash(player.id);
      return tokenHash !== null && this.readMembership(tokenHash)?.role === "host";
    });
    const humanCount = room.players.filter((player) => player.kind === "human").length;
    return {
      instanceId: room.instanceId,
      hostPlayerId: host?.id ?? null,
      ...roomPublicMetadataSchema.parse({
        id: room.id,
        game: room.settings.game,
        mode: room.settings.mode,
        timeControl: room.settings.timeControl,
        status: room.status,
        hostName: host?.name ?? null,
        hostAvatarUrl: host?.kind === "human" ? host.avatarUrl : null,
        humanCount,
        cpuCount: room.players.length - humanCount,
        capacity: gameCapacity(room.settings.game),
        openSeats:
          room.status === "waiting" ? gameCapacity(room.settings.game) - room.players.length : 0,
        updatedAtMs: room.publicUpdatedAtMs,
      }),
    };
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
    if (this.pendingAnalytics().size) this.ctx.waitUntil(this.flushAnalytics());
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
          : isShogiRoom(room)
            ? this.ctx.storage.kv.get<{ applyAt: number }>("standard-shogi-cpu-job")
            : undefined;
        const earliestCpuMoveAt = room.clock.turnStartedAt + cpuMoveDelayMs;
        deadlines.push(job ? Math.max(job.applyAt, earliestCpuMoveAt) : earliestCpuMoveAt);
      }
    }
    const pending = this.ctx.storage.kv.get<PendingRoomIndex>(pendingIndexKey);
    if (pending !== undefined) deadlines.push(pending.retryAtMs);
    for (const job of this.ctx.storage.kv.get<AccountCleanup[]>(accountCleanupKey) ?? [])
      deadlines.push(job.retryAtMs);
    for (const job of this.pendingAnalytics().values()) deadlines.push(job.retryAtMs);
    for (const job of this.pendingMatches().values()) deadlines.push(job.retryAtMs);
    for (const job of this.pendingShogiMatches().values()) deadlines.push(job.retryAtMs);
    const next = earliestAlarmAt(deadlines);
    const current = await this.ctx.storage.getAlarm();
    if (next === current) return;
    if (next === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next);
  }

  async createRoom(
    room: Room,
    tokenHash: string,
    admission?: AccountAdmission,
    analytics?: AnalyticsIdentity,
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
        if (analytics)
          this.ctx.storage.kv.put(analyticsPlayerKey(initialRoom.players[0].id), analytics);
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

  async getRoomSnapshot(formationAnalysis = false, stamps = false) {
    const room = await this.getRoom();
    return room === null
      ? null
      : {
          room,
          presence: this.presence(room),
          serverNowMs: Date.now(),
          ...roomFormationAnalysis(room, formationAnalysis),
          ...(stamps ? { stampsSupported: true as const } : {}),
        };
  }

  async resolvePlayerProfile(instanceId: string, playerId: string) {
    const room = await this.getRoom();
    if (!room) return { status: "not_found" as const };
    if (room.instanceId !== instanceId) return { status: "room_changed" as const };
    const player = room.players.find((p) => p.id === playerId);
    if (!player) return { status: "not_found" as const };
    return {
      status: "found" as const,
      game: room.settings.game,
      player,
      accountId: this.storedAccount(playerId)?.accountId ?? null,
    };
  }

  async getPublicMetadata(profilePreview = false) {
    await this.reconcileDeadlines();
    const room = this.readRoom();
    if (room === null) return null;
    const { instanceId, hostPlayerId, ...metadata } = this.publicMetadata(room);
    return { ...metadata, ...(profilePreview ? { instanceId, hostPlayerId } : {}) };
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
    analytics?: AnalyticsIdentity,
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
        if (room.players.length >= gameCapacity(room.settings.game)) {
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
              ...(isFourShogiRoom(room) || isShogiRoom(room) ? { side: null } : { color: null }),
              reconnectDeadline: Date.now() + reconnectGraceMs,
            },
          ],
        });
        const membership = roomMembershipSchema.parse({ playerId, role: "player" });
        if (analytics) this.ctx.storage.kv.put(analyticsPlayerKey(playerId), analytics);
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
    this.releaseAccount(
      playerId,
      !room.lastRound?.players.some((player) => player.id === playerId),
    );
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
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      const attachment: unknown = socket.deserializeAttachment();
      if (
        typeof attachment === "object" &&
        attachment !== null &&
        "tokenHash" in attachment &&
        attachment.tokenHash === tokenHash
      ) {
        socket.send(JSON.stringify(this.authenticationMessage(socket, membership)));
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
    const now = Date.now();
    const promoted: string[] = [];
    let changed = false;
    const updated = this.withIndexTransaction(() => {
      // 将棋の読取りは従来どおりtransaction内。リバーシは最初の読取りを使用。
      let room: Room | null =
        initial && (isFourShogiRoom(initial) || isShogiRoom(initial)) ? this.readRoom() : initial;
      if (!room) return null;
      if (room.lastActivityAtMs + idleMs <= now || this.closeIfNoHumanParticipants(room) === null) {
        if (room.lastActivityAtMs + idleMs <= now) this.closeRoom();
        changed = true;
        return null;
      }
      const players = room.players.map((player) => {
        const hash = this.playerTokenHash(player.id);
        if (
          !this.isHumanParticipant(player) ||
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
        room = roomSchema.parse({ ...room, players });
        this.ctx.storage.kv.put(roomStorageKey, room);
      }
      while (room) {
        const deadline = nextDueRoomDeadline(
          room.status === "playing" ? room.clock.turnExpiresAt : null,
          room.players,
          now,
        );
        if (!deadline) break;
        if (room.status === "playing" && deadline.type === "timeout") {
          if (isFourShogiRoom(room)) {
            const turn: Extract<FourShogiRoom, { status: "playing" }>["game"]["turn"] =
              room.game.turn;
            const player: FourShogiRoom["players"][number] | undefined = room.players.find(
              (p) => p.side === turn,
            );
            if (!player) throw new Error("Missing timed-out player");
            room = this.applyProgress(
              this.shogiProgress.eliminate(room, player.id, "timeout", deadline.at),
            );
          } else if (isShogiRoom(room)) {
            const turn: "south" | "north" = room.game.turn;
            const timed: ShogiRoom["players"][number] | undefined = room.players.find(
              (p) => p.side === turn,
            );
            if (!timed) throw new Error("Missing timed-out shogi player");
            room = this.applyProgress(
              this.standardShogiProgress.eliminate(room, timed.id, "timeout", deadline.at),
            );
          } else if (isGomokuRoom(room)) {
            const turn: "black" | "white" = room.game.turn;
            const player: GomokuRoom["players"][number] | undefined = room.players.find(
              (p) => p.color === turn,
            );
            if (!player) throw Error("Missing timed-out player");
            room = this.applyProgress(
              this.gomokuProgress.eliminate(room, player.id, "timeout", deadline.at),
            );
          } else if (isReversiRoom(room)) {
            const turn: "black" | "white" = room.game.turn;
            const player: ReversiRoom["players"][number] | undefined = room.players.find(
              (p) => p.color === turn,
            );
            if (!player) throw Error("Missing timed-out player");
            room = this.applyProgress(
              this.standardProgress.eliminate(room, player.id, "timeout", deadline.at),
            );
          } else {
            const turn: Extract<FourReversiRoom, { status: "playing" }>["game"]["turn"] =
              room.game.turn;
            const player: FourReversiRoom["players"][number] | undefined = room.players.find(
              (p) => p.color === turn,
            );
            if (!player) throw new Error("Missing timed-out player");
            room = this.applyProgress(
              this.reversiProgress.eliminate(room, player.id, "timeout", deadline.at),
            );
          }
        } else if (deadline.type === "disconnect") {
          const player: Room["players"][number] | undefined = room.players.find(
            (p) => p.id === deadline.playerId,
          );
          if (!player) throw new Error("Deadline player is missing");
          if (room.status === "waiting") {
            const wasHost = room.players[0].id === player.id;
            room = this.removeWaitingPlayer(room, player.id);
            if (wasHost && room) {
              const hash = this.playerTokenHash(room.players[0].id);
              if (hash) promoted.push(hash);
            }
          } else {
            this.recordDeparture(player);
            this.releaseAccount(player.id, false);
            room = isFourShogiRoom(room)
              ? this.applyProgress(
                  this.shogiProgress.eliminate(room, player.id, "disconnected", deadline.at),
                )
              : isShogiRoom(room)
                ? this.applyProgress(
                    this.standardShogiProgress.eliminate(
                      room,
                      player.id,
                      "disconnected",
                      deadline.at,
                    ),
                  )
                : isGomokuRoom(room)
                  ? this.applyProgress(
                      this.gomokuProgress.eliminate(room, player.id, "disconnected", deadline.at),
                    )
                  : isReversiRoom(room)
                    ? this.applyProgress(
                        this.standardProgress.eliminate(
                          room,
                          player.id,
                          "disconnected",
                          deadline.at,
                        ),
                      )
                    : this.applyProgress(
                        this.reversiProgress.eliminate(
                          room,
                          player.id,
                          "disconnected",
                          deadline.at,
                        ),
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
        room?.status === "playing" &&
        room.clock.turnStartedAt + cpuMoveDelayMs <= now &&
        !isClockExpired(room.clock, now)
      ) {
        if (isFourShogiRoom(room)) {
          if (applyCpu && currentCpu(room) !== null) {
            const proposal = this.shogiProgress.cpuDraw(room, now);
            if (proposal.kind !== "unchanged") {
              room = this.applyProgress(proposal);
              if (room) this.ctx.storage.kv.put(roomStorageKey, room);
              changed = true;
            }
            if (!room || room.status !== "playing") return room;
            if (!isFourShogiRoom(room)) throw new Error("Expected Shogi room");
            const result = this.shogiProgress.cpu(room, now);
            if (result.kind !== "unchanged") {
              room = this.applyProgress(result);
              if (room) this.ctx.storage.kv.put(roomStorageKey, room);
              changed = true;
            }
          }
        } else if (isShogiRoom(room)) {
          if (applyCpu && currentCpu(room) !== null) {
            const proposal = this.standardShogiProgress.cpuDraw(room, now);
            if (proposal.kind !== "unchanged") {
              room = this.applyProgress(proposal);
              if (room) this.ctx.storage.kv.put(roomStorageKey, room);
              changed = true;
            }
            if (!room || room.status !== "playing") return room;
            if (!isShogiRoom(room)) throw new Error("Expected Shogi room");
            const result = this.standardShogiProgress.cpu(room, now);
            if (result.kind !== "unchanged") {
              room = this.applyProgress(result);
              if (room) this.ctx.storage.kv.put(roomStorageKey, room);
              changed = true;
            }
          }
        } else {
          const result = isGomokuRoom(room)
            ? this.gomokuProgress.cpu(room, now)
            : isReversiRoom(room)
              ? this.standardProgress.cpu(room, now)
              : this.reversiProgress.cpu(room, now);
          if (result.kind !== "unchanged") {
            room = this.applyProgress(result);
            if (room) this.ctx.storage.kv.put(roomStorageKey, room);
            changed = true;
          }
        }
      }
      return room;
    });
    await this.syncAlarm(updated);
    await this.flushRoomIndex();
    await this.flushAccountCleanup();
    if (!initial || !isFourShogiRoom(initial)) this.ctx.waitUntil(this.flushMatches());
    if (changed) {
      if (updated) this.broadcastRoom(updated);
      else this.closeSockets();
    }
    for (const hash of promoted) this.sendCurrentMembership(hash);
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
        updated = this.applyProgress(this.shogiProgress.eliminate(room, player.id, "left", at));
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
      } else if (isShogiRoom(room)) {
        this.recordDeparture(player);
        this.releaseAccount(player.id, false);
        this.ctx.storage.kv.delete(membershipStorageKey(tokenHash));
        this.ctx.storage.kv.delete(playerTokenKey(player.id));
        const at = Date.now();
        updated = this.applyProgress(
          this.standardShogiProgress.eliminate(room, player.id, "left", at),
        );
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
      } else if (isGomokuRoom(room)) {
        this.recordDeparture(player);
        this.releaseAccount(player.id, false);
        const prepared = this.gomokuProgress.prepareLeave(room, player.id);
        this.ctx.storage.kv.delete(membershipStorageKey(tokenHash));
        this.ctx.storage.kv.delete(playerTokenKey(player.id));
        updated = this.applyProgress(
          this.gomokuProgress.leave(
            room,
            player.id,
            prepared,
            Date.now(),
            membership.role === "host",
          ),
        );
        if (updated) this.ctx.storage.kv.put(roomStorageKey, updated);
      } else if (isReversiRoom(room)) {
        this.recordDeparture(player);
        this.releaseAccount(player.id, false);
        const prepared = this.standardProgress.prepareLeave(room, player.id);
        this.ctx.storage.kv.delete(membershipStorageKey(tokenHash));
        this.ctx.storage.kv.delete(playerTokenKey(player.id));
        updated = this.applyProgress(
          this.standardProgress.leave(
            room,
            player.id,
            prepared,
            Date.now(),
            membership.role === "host",
          ),
        );
        if (updated) this.ctx.storage.kv.put(roomStorageKey, updated);
      } else {
        const player = room.players.find((entry) => entry.id === membership.playerId)!;
        this.recordDeparture(player);
        this.releaseAccount(player.id, false);
        const prepared = this.reversiProgress.prepareLeave(room, player.id);
        this.ctx.storage.kv.delete(membershipStorageKey(tokenHash));
        this.ctx.storage.kv.delete(playerTokenKey(player.id));
        const at = Date.now();
        updated = this.applyProgress(
          this.reversiProgress.leave(room, player.id, prepared, at, membership.role === "host"),
        );
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
    let regular: string | undefined;
    let analyzed: string | undefined;
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      try {
        const requested = this.ctx.getTags(socket).includes(formationAnalysisTag);
        const message = requested
          ? (analyzed ??= JSON.stringify(this.roomSnapshot(room, true)))
          : (regular ??= JSON.stringify(this.roomSnapshot(room)));
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

  private roomSnapshot(room: Room, formationAnalysis = false): RoomSocketMessage {
    return roomSocketContract.message.parse({
      type: "room.snapshot",
      room,
      presence: this.presence(room),
      serverNowMs: Date.now(),
      ...roomFormationAnalysis(room, formationAnalysis),
    });
  }

  private sendRoomSnapshot(socket: WebSocket, room: Room): void {
    socket.send(
      JSON.stringify(
        this.roomSnapshot(room, this.ctx.getTags(socket).includes(formationAnalysisTag)),
      ),
    );
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
      if (!player || !this.isHumanParticipant(player)) return "unauthorized";
      if ((this.ctx.storage.kv.get<string[]>(mutedKey) ?? []).includes(player.id)) return "muted";
      const now = Date.now();
      if (
        now - (this.ctx.storage.kv.get<number>(lastChatAtKey(player.id)) ?? -Infinity) <
        roomInteractionIntervalMs
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

  private interactionAvailableAtMs(playerId: string): number {
    const at = this.ctx.storage.kv.get<number>(lastChatAtKey(playerId));
    return at === undefined ? 0 : at + roomInteractionIntervalMs;
  }

  private authenticationMessage(socket: WebSocket, membership: RoomMembership): RoomSocketMessage {
    return roomSocketContract.message.parse({
      type: "room.authenticated",
      membership,
      ...(this.ctx.getTags(socket).includes(stampTag)
        ? { interactionAvailableAtMs: this.interactionAvailableAtMs(membership.playerId) }
        : {}),
    });
  }

  private sendStamp(
    tokenHash: string,
    command: Extract<RoomSocketClientMessage, { type: "room.stamp.send" }>,
  ):
    | { status: "sent"; notification: RoomStampNotification; room: Room }
    | { status: "unauthorized" | "muted" | "room_changed" }
    | { status: "rate_limited"; interactionAvailableAtMs: number } {
    return this.withIndexTransaction(() => {
      const room = this.readRoom();
      const membership = this.readMembership(tokenHash);
      if (!room || !membership) return { status: "unauthorized" };
      if (room.instanceId !== command.instanceId) return { status: "room_changed" };
      const player = room.players.find((entry) => entry.id === membership.playerId);
      if (!player || !this.isHumanParticipant(player)) return { status: "unauthorized" };
      if ((this.ctx.storage.kv.get<string[]>(mutedKey) ?? []).includes(player.id))
        return { status: "muted" };
      const now = Date.now();
      const interactionAvailableAtMs = this.interactionAvailableAtMs(player.id);
      if (now < interactionAvailableAtMs)
        return { status: "rate_limited", interactionAvailableAtMs };
      const updated = roomSchema.parse({ ...room, lastActivityAtMs: now });
      const notification: RoomStampNotification = {
        type: "room.stamp.received",
        id: crypto.randomUUID(),
        instanceId: room.instanceId,
        requestId: command.requestId,
        senderId: player.id,
        stampId: command.stampId,
        sentAtMs: now,
      };
      this.ctx.storage.kv.put(lastChatAtKey(player.id), now);
      this.ctx.storage.kv.put(roomStorageKey, updated);
      return { status: "sent", notification, room: updated };
    });
  }

  private broadcastStamp(notification: RoomStampNotification): void {
    const payload = JSON.stringify(roomSocketContract.message.parse(notification));
    for (const socket of this.ctx.getWebSockets(stampTag)) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      try {
        socket.send(payload);
      } catch {
        /* 切断中の相手には再送しません。 */
      }
    }
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

  private setTimeControl(
    tokenHash: string,
    timeControl: RoomTimeControl,
  ):
    | { status: "updated"; room: Room }
    | { status: "unchanged" | "not_found" | "forbidden" | "already_started" } {
    return this.withIndexTransaction(() => {
      const room = this.readRoom();
      if (!room) return { status: "not_found" };
      if (room.status !== "waiting") return { status: "already_started" };
      if (this.readMembership(tokenHash)?.role !== "host") return { status: "forbidden" };
      if (
        room.settings.timeControl.mainTimeMs === timeControl.mainTimeMs &&
        room.settings.timeControl.byoyomiMs === timeControl.byoyomiMs
      )
        return { status: "unchanged" };
      const updated = roomSchema.parse({
        ...room,
        settings: { ...room.settings, timeControl },
        players: room.players.map((player) =>
          player.kind === "human" ? { ...player, ready: false } : player,
        ),
        lastActivityAtMs: Date.now(),
        publicUpdatedAtMs: nextPublicUpdateAt(room),
      });
      this.ctx.storage.kv.put(roomStorageKey, updated);
      return { status: "updated", room: updated };
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
      if (isGomokuRoom(room) || isReversiRoom(room) || isShogiRoom(room))
        return { status: "forbidden" };
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
        if (room.players.length >= gameCapacity(room.settings.game)) return { status: "room_full" };
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
              ...(isFourShogiRoom(room) || isShogiRoom(room) ? { side: null } : { color: null }),
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
        room.players.length !== gameCapacity(room.settings.game) ||
        room.players.some((player) => {
          if (player.kind === "cpu") return false;
          const hash = this.playerTokenHash(player.id);
          return !player.ready || hash === null || !this.hasOpenConnection(hash);
        })
      ) {
        return { status: "not_ready" };
      }

      const started = isFourShogiRoom(room)
        ? this.shogiProgress.start(room)
        : isShogiRoom(room)
          ? this.standardShogiProgress.start(room)
          : isGomokuRoom(room)
            ? this.gomokuProgress.start(room)
            : isReversiRoom(room)
              ? this.standardProgress.start(room)
              : this.reversiProgress.start(room);
      this.releaseResultAvatars(room, new Set(started.room.players.map((player) => player.id)));
      this.startAnalyticsMatch(started.roundId, started.room, started.at);
      return { status: "started", room: started.room };
    });
  }

  private placeStone(
    tokenHash: string,
    action: import("@tetraboard/protocol").ActionFor<"four-reversi">,
  ): { status: "placed"; room: Room | null } | { status: RoomSocketError } {
    return this.withIndexTransaction(() => {
      const room = this.readRoom();
      if (!room) return { status: "not_found" };
      if (isGomokuRoom(room) || isFourShogiRoom(room) || isShogiRoom(room))
        return { status: "invalid_move" };
      const result = isReversiRoom(room)
        ? this.standardProgress.play(room, tokenHash, { type: "room.game.action", action })
        : this.reversiProgress.play(room, tokenHash, { type: "room.game.action", action });
      if (result.kind === "rejected") return { status: result.error };
      const updated = this.applyProgress(result);
      if (updated) this.ctx.storage.kv.put(roomStorageKey, updated);
      return { status: "placed", room: updated };
    });
  }
  private resign(
    tokenHash: string,
  ): { status: "resigned"; room: Room | null } | { status: RoomSocketError } {
    return this.withIndexTransaction(() => {
      const room = this.readRoom();
      if (!room) return { status: "not_found" };
      const result = isFourShogiRoom(room)
        ? this.shogiProgress.resign(room, tokenHash)
        : isShogiRoom(room)
          ? this.standardShogiProgress.resign(room, tokenHash)
          : isGomokuRoom(room)
            ? this.gomokuProgress.resign(room, tokenHash)
            : isReversiRoom(room)
              ? this.standardProgress.resign(room, tokenHash)
              : this.reversiProgress.resign(room, tokenHash);
      if (result.kind === "rejected") return { status: result.error };
      const updated = this.applyProgress(result);
      if (updated) this.ctx.storage.kv.put(roomStorageKey, updated);
      return { status: "resigned", room: updated };
    });
  }

  private rejectAction(socket: WebSocket, error: RoomSocketError): void {
    this.sendSocketError(socket, error);
    const room = this.readRoom();
    if (room !== null && socket.readyState === WebSocket.OPEN) {
      this.sendRoomSnapshot(socket, room);
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
    this.ctx.acceptWebSocket(server, [
      ...(query.data.formationAnalysis === "1" ? [formationAnalysisTag] : []),
      ...(query.data.stamps === "1" ? [stampTag] : []),
    ]);
    this.sendRoomSnapshot(server, room);
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
      // スタンプの拒否は、並行する準備や着手の応答と区別します。
      const stampError =
        typeof body === "object" &&
        body !== null &&
        "type" in body &&
        body.type === "room.stamp.send" &&
        "requestId" in body
          ? roomSocketContract.message.safeParse({
              type: "room.stamp.error",
              requestId: body.requestId,
              error: "invalid_request",
            })
          : null;
      if (stampError?.success && this.ctx.getTags(socket).includes(stampTag))
        socket.send(JSON.stringify(stampError.data));
      else this.sendSocketError(socket, "invalid_request");
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
        socket.send(JSON.stringify(this.authenticationMessage(socket, result.membership)));
        return;
      }

      const attachment: unknown = socket.deserializeAttachment();
      const tokenHash =
        typeof attachment === "object" && attachment !== null && "tokenHash" in attachment
          ? membershipTokenSchema.safeParse(attachment.tokenHash)
          : null;
      if (parsed.data.type === "room.stamp.send") {
        if (!this.ctx.getTags(socket).includes(stampTag)) {
          this.sendSocketError(socket, "invalid_request");
          return;
        }
        const result = tokenHash?.success
          ? this.sendStamp(tokenHash.data, parsed.data)
          : { status: "unauthorized" as const };
        if (result.status === "sent") {
          await this.syncAlarm(result.room);
          this.broadcastStamp(result.notification);
        } else {
          socket.send(
            JSON.stringify(
              roomSocketContract.message.parse({
                type: "room.stamp.error",
                requestId: parsed.data.requestId,
                error: result.status,
                ...("interactionAvailableAtMs" in result
                  ? { interactionAvailableAtMs: result.interactionAvailableAtMs }
                  : {}),
              }),
            ),
          );
        }
        return;
      }

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
            this.sendRoomSnapshot(socket, room);
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

      if (parsed.data.type === "room.gomoku-forbidden.set") {
        const result = this.setGomokuForbidden(tokenHash.data, parsed.data.enabled);
        if (result.status === "updated") this.broadcastRoom(result.room);
        else if (result.status === "unchanged") {
          const room = this.readRoom();
          if (room) this.sendRoomSnapshot(socket, room);
        } else this.rejectAction(socket, result.status);
        return;
      }
      if (parsed.data.type === "room.three-player-attack.set") {
        const result = this.setThreePlayerAttack(tokenHash.data, parsed.data.prohibited);
        if (result.status === "updated") this.broadcastRoom(result.room);
        else if (result.status === "unchanged") {
          const room = this.readRoom();
          if (room) this.sendRoomSnapshot(socket, room);
        } else this.rejectAction(socket, result.status);
        return;
      }
      if (parsed.data.type === "room.time-control.set") {
        const result = this.setTimeControl(tokenHash.data, parsed.data.timeControl);
        if (result.status === "updated") this.broadcastRoom(result.room);
        else if (result.status === "unchanged") {
          const room = this.readRoom();
          if (room) this.sendRoomSnapshot(socket, room);
        } else this.rejectAction(socket, result.status);
        return;
      }
      if (parsed.data.type === "room.mode.set") {
        const result = this.setMode(tokenHash.data, parsed.data.mode);
        if (result.status === "updated") this.broadcastRoom(result.room);
        else if (result.status === "unchanged") {
          const room = this.readRoom();
          if (room !== null) this.sendRoomSnapshot(socket, room);
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
          if (room !== null) this.sendRoomSnapshot(socket, room);
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

      if (parsed.data.type === "room.game.draw.set" || parsed.data.type === "room.game.declare") {
        const result =
          parsed.data.type === "room.game.declare"
            ? this.declareShogi(tokenHash.data, parsed.data)
            : this.setShogiDrawProposal(tokenHash.data, parsed.data);
        if (result.status === "updated") {
          await this.syncAlarm(result.room);
          if (result.room === null) this.closeSockets();
          else this.broadcastRoom(result.room);
        } else if (result.status === "unchanged") {
          if (result.room) this.sendRoomSnapshot(socket, result.room);
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
          : command.roundId !== undefined && command.positionRevision !== undefined
            ? command.action.type === "placeGomokuStone"
              ? this.playGomoku(tokenHash.data, {
                  type: "room.game.action",
                  action: command.action,
                  roundId: command.roundId,
                  positionRevision: command.positionRevision,
                })
              : this.playShogi(tokenHash.data, {
                  type: "room.game.action",
                  action: command.action,
                  roundId: command.roundId,
                  positionRevision: command.positionRevision,
                })
            : { status: "invalid_request" as const };
      if (result.status === "placed") {
        await this.syncAlarm(result.room);
        if (result.room === null) this.closeSockets();
        else this.broadcastRoom(result.room);
      } else if (result.status === "time_expired") {
        await this.reconcileDeadlines();
        this.rejectAction(socket, result.status);
      } else this.rejectAction(socket, result.status);
    } catch {
      if (parsed.data.type === "room.stamp.send" && this.ctx.getTags(socket).includes(stampTag)) {
        socket.send(
          JSON.stringify({
            type: "room.stamp.error",
            requestId: parsed.data.requestId,
            error: "internal_error",
          }),
        );
      } else this.sendSocketError(socket, "internal_error");
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
