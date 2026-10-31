import {
  FourShogiTrialCpu,
  trialCpuSettingsKey,
  trialCpuDiagnosticsKey,
  type TrialCpuSettings,
} from "../fourShogiAi/cpu";
import { gatewayConfig } from "../fourShogiAi/client";
import type { AiCpuProfile } from "@tetraboard/protocol/four-shogi-ai";
import { prepareRoomSettings } from "./applyRoomSettings";
import { shogiEliminatedHandsKey, eliminatedHandsTag } from "./fourShogiProgress";
import { retiredName } from "../privacy/identity";
import type { PendingMatch as PendingFourGomokuMatch } from "./fourGomokuMatchStore";
import { fourGomokuCpuJobKey, type FourGomokuCpuJob } from "./fourGomokuProgress";
import { isFourGomokuRoom, type FourGomokuRoom } from "@tetraboard/protocol";
import { gomokuCpuJobKey, type GomokuCpuJob } from "./gomokuProgress";
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
  tournamentRules,
  fourShogiRoomSchema,
  roomSchema,
  roomSocketContract,
  isFourShogiRoom,
  isFourReversiRoom,
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
import { fourReversiCpuJobKey } from "./fourReversiProgress";
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
import { retryPendingMatchClaims } from "../accounts/matchClaims";
import { readStoredMatch } from "../accounts/matchDataContracts";
import { releaseReservation, type AccountAdmission } from "../accounts/roomAccounts";
import { DurableObject } from "cloudflare:workers";
import { waitingRoomFactories } from "./waitingRoomFactories";
import {
  tournamentRoomKey,
  tournamentReservationKey,
  pendingTournamentStatePrefix,
  cancelledTournamentKey,
  tournamentCredentialVersionKey,
  tournamentReturnKey,
  prepareTournamentRoomSchema,
  writeTournamentState,
  type PrepareTournamentRoomInput,
  type TournamentRoomReservation,
  type PendingTournamentState,
  type RekeyTournamentPlayerInput,
  type TournamentReturn,
} from "./tournamentRoom";
import { isClockExpired } from "./clock";
import { writeRoomIndex, type IndexedRoomParticipant, type PendingRoomIndex } from "./roomIndex";
import { matchStartKey, pendingMatchPrefix, writeMatch, type PendingMatch } from "./matchStore";
import {
  activeRegistrationKey,
  cancelledRegistrationKey,
  guestRegistrationState,
  registrationClaimMs,
  registrationHoldMs,
  registrationKey,
  registrationPrefix,
  registrationTargetKey,
  type BeginGuestRegistrationResult,
  type CompleteGuestRegistrationResult,
  type GuestRegistrationInput,
  type GuestRegistrationState,
  type StoredGuestRegistration,
} from "./registrationTypes";

const accountKey = (playerId: string) => `seat-account:${playerId}`;
const cancelledAdmissionKey = (operationId: string) => `cancelled-admission:${operationId}`;
const accountCleanupKey = "account-cleanups";
const guestClaimsKey = "guest-match-claims-pending";
type PendingGuestClaims = { generation: string; retryAtMs: number };
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
  private guestClaimsFlush: Promise<void> | null = null;
  private matchFlush: Promise<void> | null = null;
  private shogiMatchFlush: Promise<void> | null = null;
  private tournamentStateFlush: Promise<void> | null = null;
  private readonly progressDependencies = {
    storage: this.ctx.storage,
    membership: (hash: string) => this.readMembership(hash),
    accountId: (playerId: string) => this.storedAccount(playerId)?.accountId ?? null,
  };
  private readonly reversiProgress = gameProgress["four-reversi"].create(this.progressDependencies);
  private readonly fourGomokuProgress = gameProgress["four-gomoku"].create(
    this.progressDependencies,
  );
  private readonly gomokuProgress = gameProgress.gomoku.create(this.progressDependencies);
  private readonly standardProgress = gameProgress.reversi.create(this.progressDependencies);
  private readonly shogiProgress = gameProgress["four-shogi"].create(this.progressDependencies);
  private readonly standardShogiProgress = gameProgress.shogi.create(this.progressDependencies);
  private readonly trialCpu = new FourShogiTrialCpu({
    storage: this.ctx.storage,
    env: this.env,
    progress: this.shogiProgress,
    readRoom: () => this.readRoom(),
    accountId: (playerId) => this.storedAccount(playerId)?.accountId ?? null,
    changed: () => this.syncAlarm(this.readRoom()),
    waitUntil: (promise) => this.ctx.waitUntil(promise),
  });
  async configureTrialCpu(
    accountId: string,
    tokenHash: string,
    instanceId: string,
    playerId: string,
    profile: AiCpuProfile | null,
  ) {
    await this.reconcileDeadlines();
    return this.withIndexTransaction(() => {
      const room = this.readRoom(),
        membership = this.readMembership(tokenHash);
      const config = gatewayConfig(this.env);
      if (!room || room.instanceId !== instanceId) return { error: "room_not_found" as const };
      if (
        !membership ||
        membership.role !== "host" ||
        this.storedAccount(membership.playerId)?.accountId !== accountId ||
        !config.ids.includes(accountId)
      )
        return { error: "trial_forbidden" as const };
      if (!isFourShogiRoom(room) || room.settings.mode !== "singles" || room.status !== "waiting")
        return { error: "unsupported_room" as const };
      const cpu = room.players.find((p) => p.id === playerId);
      if (
        cpu?.kind !== "cpu" ||
        cpu.level !== 2 ||
        !room.players.every(
          (p) => p.kind === "cpu" || config.ids.includes(this.storedAccount(p.id)?.accountId ?? ""),
        )
      )
        return { error: "trial_forbidden" as const };
      const saved = this.ctx.storage.kv.get<TrialCpuSettings>(trialCpuSettingsKey);
      const settings: TrialCpuSettings =
        saved?.instanceId === instanceId && saved.ownerId === accountId
          ? saved
          : { instanceId, ownerId: accountId, players: {} };
      if (profile) settings.players[playerId] = profile;
      else delete settings.players[playerId];
      this.ctx.storage.kv.put(trialCpuSettingsKey, settings);
      return { settings: { instanceId, players: settings.players } };
    });
  }
  trialCpuDiagnostics(accountId: string, instanceId: string) {
    const room = this.readRoom();
    if (
      !room ||
      room.instanceId !== instanceId ||
      !gatewayConfig(this.env).ids.includes(accountId) ||
      !room.players.some((p) => this.storedAccount(p.id)?.accountId === accountId)
    )
      return null;
    return this.ctx.storage.kv.get<object[]>(trialCpuDiagnosticsKey) ?? [];
  }
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
            playerId:
              identity && !identity.accountId && !identity.visitorId ? crypto.randomUUID() : p.id,
            visitorId: identity?.visitorId ?? null,
            accountId: identity
              ? identity.accountId
              : (this.storedAccount(p.id)?.accountId ?? null),
            isTest: identity?.isTest ?? false,
            isGuest: identity?.isGuest ?? this.storedAccount(p.id)?.isGuest ?? false,
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
              this.ctx.storage.kv.put(key, {
                ...this.ctx.storage.kv.get<AnalyticsJob>(key)!,
                retryAtMs: Date.now() + 5000,
              });
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
      this.ctx.storage.kv.list<
        PendingMatch | PendingReversiMatch | PendingGomokuMatch | PendingFourGomokuMatch
      >({
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
            "tournament" in job ? job.tournament : undefined,
          );
          this.ctx.storage.transactionSync(() => {
            const latest = this.pendingShogiMatches().get(key);
            if (!latest) return;
            if (progress)
              this.ctx.storage.kv.put(key, { ...latest, progress, retryAtMs: Date.now() + 1 });
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
          const latest = this.pendingShogiMatches().get(key);
          if (latest) this.ctx.storage.kv.put(key, { ...latest, retryAtMs: Date.now() + 5_000 });
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
          const latest = this.pendingMatches().get(key);
          if (latest) this.ctx.storage.kv.put(key, { ...latest, retryAtMs: Date.now() + 5_000 });
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

  async guestMergeConflict(guestId: string, accountId: string): Promise<boolean> {
    const includesBoth = (value: unknown): boolean => {
      if (!value || typeof value !== "object") return false;
      if (Array.isArray(value)) return value.some(includesBoth);
      const row = value as Record<string, unknown>;
      if (Array.isArray(row.participants)) {
        const ids = new Set(
          row.participants.map((player: { accountId?: string }) => player?.accountId),
        );
        if (ids.has(guestId) && ids.has(accountId)) return true;
      }
      return Object.values(row).some(includesBoth);
    };
    // 保存待ちの記録も確認し、D1へまだ届いていない同局の複数席取得を防ぎます。
    for (const [, value] of this.ctx.storage.kv.list()) if (includesBoth(value)) return true;
    return false;
  }

  async purgeAccount(accountId: string) {
    await this.ctx.blockConcurrencyWhile(async () => {
      const aliases = await this.env.APP_DB.prepare(
        "SELECT guest_id FROM guest_account_merges WHERE account_id=?",
      )
        .bind(accountId)
        .all<{ guest_id: string }>();
      const accountIds = new Set([accountId, ...aliases.results.map((row) => row.guest_id)]);
      const entries = [...this.ctx.storage.kv.list<unknown>()];
      const ids = new Set<string>();
      const names = new Set<string>();
      const matchPlayers = new Map<string, Set<string>>();
      const rememberMatchPlayer = (matchId: string, playerId: string) => {
        const players = matchPlayers.get(matchId) ?? new Set<string>();
        players.add(playerId);
        matchPlayers.set(matchId, players);
      };
      const code =
        this.ctx.id.name ??
        this.readRoom()?.id ??
        this.ctx.storage.kv.get<PendingRoomIndex>(pendingIndexKey)?.metadata.id;
      if (code) {
        const retained = await this.env.APP_DB.prepare(
          "SELECT player_id FROM privacy_room_players WHERE account_id=? AND room_id=?",
        )
          .bind(accountId, code)
          .all<{ player_id: string }>();
        for (const row of retained.results) ids.add(row.player_id);
        const matchIdentities = await this.env.APP_DB.prepare(`
          SELECT m.id AS match_id, json_extract(p.value, '$.id') AS player_id
          FROM matches m, json_each(m.record_json, '$.participants') p
          WHERE json_extract(m.record_json, '$.roomId')=? AND (
            json_extract(p.value, '$.accountId')=? OR
            (json_extract(p.value, '$.retired')=1 AND EXISTS (
              SELECT 1 FROM privacy_room_players r WHERE r.account_id=? AND r.room_id=?
                AND r.instance_id=json_extract(m.record_json, '$.instanceId')
                AND r.player_id=json_extract(p.value, '$.id'))))
          UNION SELECT match_id,player_id FROM match_participant_accounts
          WHERE room_id=? AND state='retired'`)
          .bind(code, accountId, accountId, code, code)
          .all<{ match_id: string; player_id: string }>();
        for (const row of matchIdentities.results) rememberMatchPlayer(row.match_id, row.player_id);
      }
      // 同じ席IDでも、登録前の別の局へ本人情報を遡及させません。
      const collectMatchPlayers = (value: unknown): void => {
        if (Array.isArray(value)) {
          for (const item of value) collectMatchPlayers(item);
          return;
        }
        if (!value || typeof value !== "object") return;
        const row = value as Record<string, unknown>;
        if (typeof row.id === "string" && Array.isArray(row.participants)) {
          for (const participant of row.participants) {
            if (accountIds.has(participant?.accountId) && typeof participant.id === "string")
              rememberMatchPlayer(row.id, participant.id);
          }
        }
        for (const item of Object.values(row)) collectMatchPlayers(item);
      };
      for (const [, value] of entries) collectMatchPlayers(value);
      const identityScope = (row: Record<string, unknown>, inherited?: ReadonlySet<string>) => {
        if (Array.isArray(row.participants)) {
          const participants = row.participants as {
            id?: string;
            playerId?: string;
            accountId?: string;
            visitorId?: string;
          }[];
          const own = new Set(
            participants
              .filter((p) => accountIds.has(p.accountId ?? ""))
              .flatMap((p) => p.id ?? p.playerId ?? []),
          );
          if (!participants.some((p) => "visitorId" in p) && typeof row.id === "string")
            for (const id of matchPlayers.get(row.id) ?? []) own.add(id);
          return own;
        }
        if (row.game && Array.isArray(row.players)) {
          const replay = row.replay as { id?: unknown } | null | undefined;
          const matchId = typeof row.roundId === "string" ? row.roundId : replay?.id;
          if (typeof matchId === "string") return matchPlayers.get(matchId) ?? new Set<string>();
        }
        return inherited;
      };
      let found = false;
      for (const [key, value] of entries) {
        if (
          key.startsWith("seat-account:") &&
          value &&
          typeof value === "object" &&
          "accountId" in value &&
          accountIds.has(String(value.accountId))
        ) {
          const seat = value as StoredAccountSeat;
          if (seat.occupying) throw new Error("Account still seated");
          ids.add(seat.playerId);
          if (seat.avatarKey) {
            await this.env.APP_DB.prepare("INSERT OR IGNORE INTO deletion_images VALUES (?,?)")
              .bind(accountId, seat.avatarKey)
              .run();
          }
          await this.env.APP_DB.prepare(
            "DELETE FROM room_avatar_refs WHERE operation_id=? AND instance_id=?",
          )
            .bind(seat.operationId, seat.instanceId)
            .run();
        }
        const discover = async (
          v: unknown,
          inheritedScope?: ReadonlySet<string>,
        ): Promise<void> => {
          if (Array.isArray(v)) {
            for (const item of v) await discover(item, inheritedScope);
          } else if (v && typeof v === "object") {
            const row = v as Record<string, unknown>;
            const scope = identityScope(row, inheritedScope);
            const matchingIds = scope ?? ids;
            if (
              accountIds.has(String(row.accountId)) ||
              matchingIds.has(String(row.id)) ||
              matchingIds.has(String(row.playerId)) ||
              matchingIds.has(String(row.senderId)) ||
              matchingIds.has(String(row.hostPlayerId))
            ) {
              found = true;
              if (typeof row.id === "string") ids.add(row.id);
              if (typeof row.playerId === "string") ids.add(row.playerId);
              if (typeof row.name === "string") names.add(row.name);
              if (typeof row.hostName === "string") names.add(row.hostName);
              if (typeof row.avatarKey === "string")
                await this.env.APP_DB.prepare("INSERT OR IGNORE INTO deletion_images VALUES (?,?)")
                  .bind(accountId, row.avatarKey)
                  .run();
              if (typeof row.operationId === "string")
                await this.env.APP_DB.prepare("DELETE FROM room_avatar_refs WHERE operation_id=?")
                  .bind(row.operationId)
                  .run();
            }
            for (const value of Object.values(row)) await discover(value, scope);
          }
        };
        await discover(value);
      }
      if (!found) return;
      const removedKeys = new Set<string>();
      for (const id of ids) {
        const token = this.playerTokenHash(id);
        if (token) {
          removedKeys.add(membershipStorageKey(token));
          removedKeys.add(playerTokenKey(id));
          this.closeSockets(token, "Account deleted");
          this.ctx.storage.kv.delete(membershipStorageKey(token));
          this.ctx.storage.kv.delete(playerTokenKey(id));
        }
        this.ctx.storage.kv.delete(accountKey(id));
      }
      const strip = (
        value: unknown,
        inherited = false,
        inheritedScope?: ReadonlySet<string>,
      ): unknown => {
        if (Array.isArray(value)) return value.map((v) => strip(v, false, inheritedScope));
        if (!value || typeof value !== "object") return value;
        const row = value as Record<string, unknown>;
        const scope = identityScope(row, inheritedScope);
        const matchingIds = scope ?? ids;
        const own =
          inherited ||
          accountIds.has(String(row.accountId)) ||
          matchingIds.has(String(row.id)) ||
          matchingIds.has(String(row.playerId)) ||
          matchingIds.has(String(row.senderId)) ||
          matchingIds.has(String(row.hostPlayerId));
        if (
          row.kind === "system" &&
          typeof row.text === "string" &&
          [...names].some(
            (name) => row.text === `${name}が入室しました` || row.text === `${name}が退室しました`,
          )
        )
          return {
            ...row,
            text: `${retiredName}${row.text.endsWith("が入室しました") ? "が入室しました" : "が退室しました"}`,
          };
        const out = Object.fromEntries(
          Object.entries(row).map(([key, v]) => [
            key,
            own && ["name", "senderName", "hostName"].includes(key)
              ? retiredName
              : own &&
                  ["accountId", "avatarUrl", "avatarKey", "profileId", "hostAvatarUrl"].includes(
                    key,
                  )
                ? null
                : strip(v, own && key === "appearance", scope),
          ]),
        );
        if (own && row.kind === "human") out.retired = true;
        if (own && "visitorId" in row) out.visitorId = null;
        return out;
      };
      for (const [key, value] of entries) {
        if (removedKeys.has(key)) continue;
        if (
          key.startsWith("seat-account:") &&
          value &&
          typeof value === "object" &&
          "accountId" in value &&
          accountIds.has(String(value.accountId))
        )
          continue;
        if (key === accountCleanupKey) {
          this.ctx.storage.kv.put(
            key,
            (value as AccountCleanup[]).filter((v) => !accountIds.has(v.reservation.accountId)),
          );
          continue;
        }
        this.ctx.storage.kv.put(key, strip(value));
      }
      this.withIndexTransaction(() => {
        const room = this.readRoom();
        if (room)
          this.ctx.storage.kv.put(roomStorageKey, {
            ...room,
            publicUpdatedAtMs: nextPublicUpdateAt(room),
          });
      });
      const room = this.readRoom();
      if (room) this.broadcastRoom(room);
      this.broadcastChat();
    });
  }

  private storedAccount(playerId: string) {
    return this.ctx.storage.kv.get<StoredAccountSeat>(accountKey(playerId)) ?? null;
  }

  private registrationForPlayer(playerId: string): StoredGuestRegistration | null {
    const id = this.ctx.storage.kv.get<string>(activeRegistrationKey(playerId));
    if (!id) return null;
    const record = this.ctx.storage.kv.get<StoredGuestRegistration>(registrationKey(id));
    return record?.state === "pending" ? record : null;
  }

  private endRegistration(
    record: StoredGuestRegistration,
    state: "cancelled" | "expired" | "released",
  ) {
    this.ctx.storage.kv.put(registrationKey(record.registrationId), { ...record, state });
    if (this.ctx.storage.kv.get(activeRegistrationKey(record.playerId)) === record.registrationId)
      this.ctx.storage.kv.delete(activeRegistrationKey(record.playerId));
  }

  private releaseRegistration(playerId: string) {
    const record = this.registrationForPlayer(playerId);
    if (record) this.endRegistration(record, "released");
  }

  private registrationView(record: StoredGuestRegistration): GuestRegistrationState {
    const result = guestRegistrationState(record);
    if (record.state === "converted") {
      const room = this.readRoom();
      const seat = this.storedAccount(record.playerId);
      if (
        room?.instanceId !== record.instanceId ||
        !seat?.occupying ||
        seat.accountId !== record.accountId ||
        this.playerTokenHash(record.playerId) !== record.newTokenHash
      )
        result.state = "released";
    }
    return result;
  }

  async getGuestRegistration(registrationId: string): Promise<GuestRegistrationState | null> {
    await this.reconcileDeadlines();
    const record = this.ctx.storage.kv.get<StoredGuestRegistration>(
      registrationKey(registrationId),
    );
    return record ? this.registrationView(record) : null;
  }

  async validateGuestRegistrationAccount(
    registrationId: string,
    accountId: string,
  ): Promise<"eligible" | "conflict" | "not_found" | "cancelled" | "expired"> {
    const record = this.ctx.storage.kv.get<StoredGuestRegistration>(
      registrationKey(registrationId),
    );
    if (!record) return "not_found";
    if (record.state === "cancelled") return "cancelled";
    if (record.claimUntilMs <= Date.now()) return "expired";
    if (
      (record.accountId && record.accountId !== accountId) ||
      record.originalAccountIds.includes(accountId)
    )
      return "conflict";
    return "eligible";
  }

  private async originalMatchAccounts(input: GuestRegistrationInput): Promise<string[] | null> {
    const pending = [
      ...this.pendingMatches().values(),
      ...this.pendingShogiMatches().values(),
    ].find((job) => job.record.id === input.matchId)?.record;
    let record = pending;
    if (!record) {
      const saved = await this.env.APP_DB.prepare("SELECT game,record_json FROM matches WHERE id=?")
        .bind(input.matchId)
        .first<{ game: string; record_json: string }>();
      if (saved) record = readStoredMatch(saved.record_json, saved.game).record;
    }
    if (!record || record.instanceId !== input.instanceId || record.roomId !== this.ctx.id.name)
      return null;
    return record.participants.flatMap((player) =>
      player.kind === "human" && player.accountId ? [player.accountId] : [],
    );
  }

  async armGuestMatchClaims(): Promise<void> {
    this.ctx.storage.kv.put(guestClaimsKey, {
      generation: crypto.randomUUID(),
      retryAtMs: Date.now(),
    } satisfies PendingGuestClaims);
    await this.syncAlarm(this.readRoom());
    this.ctx.waitUntil(this.flushGuestMatchClaims());
  }

  private async flushGuestMatchClaims(): Promise<void> {
    if (this.guestClaimsFlush) return this.guestClaimsFlush;
    const flush = async () => {
      const job = this.ctx.storage.kv.get<PendingGuestClaims>(guestClaimsKey);
      const code = this.ctx.id.name;
      if (!job || job.retryAtMs > Date.now() || !code) return;
      let pending = true;
      try {
        await retryPendingMatchClaims(this.env.APP_DB, code);
        pending = Boolean(
          await this.env.APP_DB.prepare(
            "SELECT 1 FROM match_participant_accounts WHERE room_id=? AND state='pending' LIMIT 1",
          )
            .bind(code)
            .first(),
        );
      } catch {
        console.error("Guest match claims will be retried");
      }
      this.ctx.storage.transactionSync(() => {
        const latest = this.ctx.storage.kv.get<PendingGuestClaims>(guestClaimsKey);
        if (latest?.generation !== job.generation) return;
        if (pending)
          this.ctx.storage.kv.put(guestClaimsKey, { ...job, retryAtMs: Date.now() + 5_000 });
        else this.ctx.storage.kv.delete(guestClaimsKey);
      });
      await this.syncAlarm(this.readRoom());
    };
    this.guestClaimsFlush = flush().finally(() => {
      this.guestClaimsFlush = null;
    });
    return this.guestClaimsFlush;
  }

  async beginGuestRegistration(
    input: GuestRegistrationInput,
  ): Promise<BeginGuestRegistrationResult> {
    await this.reconcileDeadlines();
    const originalAccountIds = await this.originalMatchAccounts(input);
    const result = this.withIndexTransaction((): BeginGuestRegistrationResult => {
      if (this.ctx.storage.kv.get(cancelledRegistrationKey(input.registrationId)))
        return { status: "expired" };
      const previous = this.ctx.storage.kv.get<StoredGuestRegistration>(
        registrationKey(input.registrationId),
      );
      if (previous) {
        if (
          previous.instanceId !== input.instanceId ||
          previous.matchId !== input.matchId ||
          previous.oldTokenHash !== input.oldTokenHash ||
          previous.newTokenHash !== input.newTokenHash
        )
          return { status: "registration_conflict" };
        if (
          previous.state === "cancelled" ||
          (previous.state !== "converted" && previous.claimUntilMs <= Date.now())
        )
          return { status: "expired" };
        return { status: "started", registration: this.registrationView(previous) };
      }
      const now = Date.now();
      if (
        input.newTokenHash === input.oldTokenHash ||
        !membershipTokenSchema.safeParse(input.newTokenHash).success
      )
        return { status: "registration_conflict" };
      if (
        [...this.ctx.storage.kv.list<StoredGuestRegistration>({ prefix: registrationPrefix })].some(
          ([, record]) => record.state === "pending" && record.newTokenHash === input.newTokenHash,
        )
      )
        return { status: "registration_conflict" };
      // 席を失った後も、初回に検証した本人資格から前局だけを引き継げます。
      const retained = [
        ...this.ctx.storage.kv.list<StoredGuestRegistration>({ prefix: registrationPrefix }),
      ]
        .map(([, record]) => record)
        .find(
          (record) =>
            record.instanceId === input.instanceId &&
            record.matchId === input.matchId &&
            record.oldTokenHash === input.oldTokenHash &&
            !record.accountId &&
            (record.holdUntilMs <= now || record.state === "released") &&
            record.claimUntilMs > now,
        );
      if (retained) {
        const record: StoredGuestRegistration = {
          ...retained,
          ...input,
          state: "expired",
          accountId: null,
        };
        this.ctx.storage.kv.put(registrationKey(input.registrationId), record);
        return { status: "started", registration: guestRegistrationState(record) };
      }
      const room = this.readRoom();
      if (!room) return { status: "not_found" };
      if (room.instanceId !== input.instanceId) return { status: "room_changed" };
      if (room.status !== "waiting") return { status: "room_started" };
      const membership = this.readMembership(input.oldTokenHash);
      const player = room.players.find((p) => p.id === membership?.playerId);
      if (!membership || player?.kind !== "human" || !this.isHumanParticipant(player))
        return { status: "unauthorized" };
      if (this.storedAccount(player.id)) return { status: "not_guest" };
      const last = room.lastRound;
      const matchId = last && ("roundId" in last ? last.roundId : last.replay?.id);
      if (matchId !== input.matchId || !last?.players.some((p) => p.id === player.id))
        return { status: "invalid_match" };
      if (!originalAccountIds) return { status: "invalid_match" };
      if (this.registrationForPlayer(player.id)) return { status: "registration_conflict" };
      if (
        input.newTokenHash === input.oldTokenHash ||
        !membershipTokenSchema.safeParse(input.newTokenHash).success ||
        this.readMembership(input.newTokenHash)
      )
        return { status: "registration_conflict" };
      const targetKey = registrationTargetKey(input.matchId, player.id);
      const startedAtMs = this.ctx.storage.kv.get<number>(targetKey) ?? now;
      if (startedAtMs + registrationHoldMs <= now) return { status: "expired" };
      const record: StoredGuestRegistration = {
        ...input,
        playerId: player.id,
        startedAtMs,
        holdUntilMs: startedAtMs + registrationHoldMs,
        claimUntilMs: startedAtMs + registrationClaimMs,
        state: "pending",
        accountId: null,
        originalAccountIds,
      };
      this.ctx.storage.kv.put(targetKey, startedAtMs);
      this.ctx.storage.kv.put(registrationKey(input.registrationId), record);
      this.ctx.storage.kv.put(activeRegistrationKey(player.id), input.registrationId);
      this.ctx.storage.kv.put(
        roomStorageKey,
        roomSchema.parse({
          ...room,
          lastActivityAtMs: now,
          players: room.players.map((p) =>
            p.id === player.id
              ? { ...p, ready: false, registrationPendingUntilMs: record.holdUntilMs }
              : p,
          ),
        }),
      );
      return { status: "started", registration: guestRegistrationState(record) };
    });
    const room = this.readRoom();
    await this.syncAlarm(room);
    if (room && result.status === "started") this.broadcastRoom(room);
    return result;
  }

  async cancelGuestRegistration(registrationId: string): Promise<GuestRegistrationState | null> {
    await this.reconcileDeadlines();
    this.withIndexTransaction(() => {
      const record = this.ctx.storage.kv.get<StoredGuestRegistration>(
        registrationKey(registrationId),
      );
      if (record?.state !== "converted")
        this.ctx.storage.kv.put(cancelledRegistrationKey(registrationId), true);
      if (record?.state === "pending") this.endRegistration(record, "cancelled");
    });
    // 解除後は元の切断時刻に戻し、既に過ぎた通常期限も同じ呼出しで処理します。
    await this.reconcileDeadlines();
    const record = this.ctx.storage.kv.get<StoredGuestRegistration>(
      registrationKey(registrationId),
    );
    return record ? this.registrationView(record) : null;
  }

  async completeGuestRegistration(
    registrationId: string,
    admission: AccountAdmission,
    analytics?: AnalyticsIdentity,
  ): Promise<CompleteGuestRegistrationResult> {
    await this.reconcileDeadlines();
    const completed = (): CompleteGuestRegistrationResult | null => {
      const record = this.ctx.storage.kv.get<StoredGuestRegistration>(
        registrationKey(registrationId),
      );
      if (!record) return { status: "not_found" };
      if (record.accountId && record.accountId !== admission.accountId)
        return { status: "account_conflict" };
      if (record.state === "converted") {
        const state = this.registrationView(record);
        const membership = this.readMembership(record.newTokenHash);
        return state.state === "converted" && membership
          ? { status: "converted", registration: state, membership }
          : { status: "released" };
      }
      if (record.state !== "pending") return { status: record.state };
      return null;
    };
    const prior = completed();
    if (prior) return prior;
    const result = await this.withAccountAdmission(admission, () =>
      this.withIndexTransaction((): CompleteGuestRegistrationResult => {
        const prior = completed();
        if (prior) return prior;
        const record = this.ctx.storage.kv.get<StoredGuestRegistration>(
          registrationKey(registrationId),
        )!;
        const now = Date.now();
        if (record.holdUntilMs <= now) return { status: "expired" };
        const room = this.readRoom();
        if (
          !room ||
          room.instanceId !== record.instanceId ||
          room.instanceId !== admission.instanceId ||
          room.id !== admission.roomId
        )
          return { status: "room_changed" };
        const last = room.lastRound;
        const matchId = last && ("roundId" in last ? last.roundId : last.replay?.id);
        if (
          room.status !== "waiting" ||
          matchId !== record.matchId ||
          admission.playerId !== record.playerId ||
          this.registrationForPlayer(record.playerId)?.registrationId !== registrationId
        )
          return { status: "released" };
        const membership = this.readMembership(record.oldTokenHash);
        if (membership?.playerId !== record.playerId || this.storedAccount(record.playerId))
          return { status: "released" };
        if (this.readMembership(record.newTokenHash))
          return { status: "account_reservation_invalid" };
        const updatedRecord: StoredGuestRegistration = {
          ...record,
          state: "converted",
          accountId: admission.accountId,
          admission,
        };
        this.ctx.storage.kv.put(accountKey(record.playerId), { ...admission, occupying: true });
        this.ctx.storage.kv.delete(membershipStorageKey(record.oldTokenHash));
        this.ctx.storage.kv.put(membershipStorageKey(record.newTokenHash), membership);
        this.ctx.storage.kv.put(playerTokenKey(record.playerId), record.newTokenHash);
        this.ctx.storage.kv.put(disconnectedAtKey(record.playerId), now);
        this.ctx.storage.kv.put(registrationKey(registrationId), updatedRecord);
        this.ctx.storage.kv.delete(activeRegistrationKey(record.playerId));
        const previousIdentity = this.ctx.storage.kv.get<AnalyticsIdentity>(
          analyticsPlayerKey(record.playerId),
        );
        this.ctx.storage.kv.put(analyticsPlayerKey(record.playerId), {
          visitorId: analytics?.visitorId ?? previousIdentity?.visitorId ?? null,
          accountId: admission.accountId,
          isTest: analytics?.isTest ?? false,
        } satisfies AnalyticsIdentity);
        const avatarUrl = profileAvatarUrl(admission.avatarKey);
        this.ctx.storage.kv.put(
          roomStorageKey,
          roomSchema.parse({
            ...room,
            publicUpdatedAtMs: nextPublicUpdateAt(room),
            lastActivityAtMs: now,
            players: room.players.map((p) => {
              if (p.id !== record.playerId || p.kind !== "human") return p;
              const { registrationPendingUntilMs: _pending, ...player } = p;
              return {
                ...player,
                name: admission.name,
                avatarUrl,
                ready: false,
                reconnectDeadline: now + reconnectGraceMs,
              };
            }),
            lastRound: last && {
              ...last,
              players: last.players.map((p) =>
                p.id === record.playerId
                  ? { ...p, name: admission.name, appearance: { kind: "human", avatarUrl } }
                  : p,
              ),
            },
          }),
        );
        return {
          status: "converted",
          registration: guestRegistrationState(updatedRecord),
          membership,
        };
      }),
    );
    if (result?.status === "converted") {
      const record = this.ctx.storage.kv.get<StoredGuestRegistration>(
        registrationKey(registrationId),
      )!;
      this.closeSockets(record.oldTokenHash, "Room membership updated");
      const room = this.readRoom();
      await this.syncAlarm(room);
      if (room) this.broadcastRoom(room);
    } else await this.reconcileDeadlines();
    return result ?? { status: "account_reservation_invalid" };
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
        WHERE account_id = ? AND operation_id = ? AND room_id = ? AND instance_id = ? AND player_id = ? AND name = ? AND avatar_key IS ? AND NOT EXISTS (SELECT 1 FROM deleted_accounts d WHERE d.id=account_room_seats.account_id)`)
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
    if (isFourGomokuRoom(room)) this.fourGomokuProgress.normalize(room);
    else if (isFourShogiRoom(room)) this.shogiProgress.normalize(room, saved);
    else if (isReversiRoom(room)) this.standardProgress.normalize(room, saved);
    else if (!isShogiRoom(room) && !isGomokuRoom(room) && !isFourGomokuRoom(room))
      this.reversiProgress.normalize(room, saved);
    return room;
  }

  private readMembership(tokenHash: string): RoomMembership | null {
    const value = this.ctx.storage.kv.get(membershipStorageKey(tokenHash));
    return value === undefined ? null : roomMembershipSchema.parse(value);
  }

  private publicMembership(membership: RoomMembership): RoomMembership {
    return this.storedAccount(membership.playerId)?.accountId
      ? { ...membership, accountLinked: true }
      : membership;
  }

  private playerTokenHash(playerId: string): string | null {
    return this.ctx.storage.kv.get<string>(playerTokenKey(playerId)) ?? null;
  }

  // 復帰期限切れの退室は期限イベントで確定し、復帰待ちと脱落後の在室を含めます。
  private isHumanParticipant(player: Room["players"][number]): boolean {
    if (
      player.kind !== "human" ||
      player.retired ||
      this.ctx.storage.kv.get(departedKey(player.id))
    )
      return false;
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
    const tournament = this.tournamentReservation(room);
    if (tournament) {
      const excluded = tournament.excludedPlayerIds ?? [];
      const connectedPlayerIds =
        room?.players
          .filter((player) => {
            const hash = this.playerTokenHash(player.id);
            return !excluded.includes(player.id) && hash !== null && this.hasOpenConnection(hash);
          })
          .map((player) => player.id) ?? [];
      const closed = { ...tournament, status: "closed" as const, connectedPlayerIds };
      this.ctx.storage.kv.put(tournamentReservationKey(tournament.context.matchId), closed);
      if (tournament.status === "waiting") {
        const returns: Record<string, TournamentReturn> = {};
        for (const player of room?.players ?? []) {
          const hash = this.playerTokenHash(player.id);
          if (hash)
            returns[hash] = {
              type: "room.tournament.return",
              tournamentId: tournament.context.tournamentId,
              matchId: tournament.context.matchId,
              instanceId: tournament.instanceId,
              reason: excluded.includes(player.id) ? "left" : "unavailable",
            };
        }
        this.ctx.storage.kv.put(tournamentReturnKey, returns);
      }
      if (tournament.status !== "closed") this.recordTournamentState(closed, "aborted");
      this.ctx.storage.kv.delete(tournamentRoomKey);
    }
    if (room) this.releaseResultAvatars(room, new Set());
    this.endAnalyticsMatch("abandoned", Date.now());
    for (const player of room?.players ?? []) {
      this.ctx.storage.kv.delete(analyticsPlayerKey(player.id));
      if (player.kind !== "human") continue;
      this.releaseRegistration(player.id);
      this.releaseAccount(player.id, true);
      const tokenHash = this.playerTokenHash(player.id);
      if (tokenHash !== null) this.ctx.storage.kv.delete(membershipStorageKey(tokenHash));
      this.ctx.storage.kv.delete(playerTokenKey(player.id));
      this.ctx.storage.kv.delete(tournamentCredentialVersionKey(player.id));
      this.ctx.storage.kv.delete(disconnectedAtKey(player.id));
      this.ctx.storage.kv.delete(lastChatAtKey(player.id));
      this.ctx.storage.kv.delete(departedKey(player.id));
    }
    this.ctx.storage.kv.delete(roomStorageKey);
    this.ctx.storage.kv.delete(replayKey);
    this.ctx.storage.kv.delete(matchStartKey);
    this.ctx.storage.kv.delete(shogiMatchStartKey);
    this.ctx.storage.kv.delete(shogiEliminatedHandsKey);
    this.ctx.storage.kv.delete(standardShogiMatchStartKey);
    this.ctx.storage.kv.delete(chatKey);
    this.ctx.storage.kv.delete(mutedKey);
    this.ctx.storage.kv.delete(viewerSecretKey);
    this.ctx.storage.kv.delete(shogiCpuJobKey);
    this.ctx.storage.kv.delete("standard-shogi-cpu-job");
    this.ctx.storage.kv.delete(gomokuCpuJobKey);
    this.ctx.storage.kv.delete(fourGomokuCpuJobKey);
    this.ctx.storage.kv.delete(fourReversiCpuJobKey);
    if (room && isFourShogiRoom(room)) this.shogiProgress.store().clear();
    if (room && isShogiRoom(room)) this.standardShogiProgress.store().clear();
  }

  private applyProgress(result: ProgressFor<"four-gomoku">): FourGomokuRoom | null;
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
          case "four-gomoku": {
            const lastRound = this.fourGomokuProgress.finalize(result);
            const players = this.rematchPlayers(result.room.players, result.at);
            return players === null
              ? null
              : this.fourGomokuProgress.waiting({ ...result, lastRound }, players);
          }
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
            const tournament = this.tournamentReservation(result.room);
            if (tournament) {
              const closed = { ...tournament, status: "closed" as const };
              this.ctx.storage.kv.put(tournamentReservationKey(tournament.context.matchId), closed);
              this.recordTournamentState(closed, "saving");
            }
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

  private playFourGomoku(
    tokenHash: string,
    command: import("@tetraboard/protocol").GameActionCommandFor<"four-gomoku">,
  ): { status: "placed"; room: Room | null } | { status: RoomSocketError } {
    return this.withIndexTransaction(() => {
      const room = this.readRoom();
      if (!room) return { status: "not_found" };
      if (!isFourGomokuRoom(room)) return { status: "invalid_move" };
      const result = this.fourGomokuProgress.play(room, tokenHash, command);
      if (result.kind === "rejected") return { status: result.error };
      const updated = this.applyProgress(result);
      if (updated) this.ctx.storage.kv.put(roomStorageKey, updated);
      return { status: "placed", room: updated };
    });
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
    throughEventCount?: number,
  ): Promise<
    | {
        status: "found";
        page:
          | import("@tetraboard/protocol").FourShogiReplayPage
          | import("@tetraboard/protocol").ShogiReplayPage;
      }
    | { status: "not_found" | "room_changed" | "invalid_request" }
  > {
    await this.reconcileDeadlines();
    const room = this.readRoom();
    if (!room) return { status: "not_found" };
    if (room.instanceId !== instanceId) return { status: "room_changed" };
    if (!isFourShogiRoom(room) && !isShogiRoom(room)) return { status: "not_found" };
    const live = throughEventCount !== undefined;
    if (live && !isFourShogiRoom(room)) return { status: "invalid_request" };
    const currentRound = room.status === "playing" ? room.roundId : room.lastRound?.roundId;
    if (
      live
        ? currentRound !== roundId
        : room.status !== "waiting" || room.lastRound?.roundId !== roundId
    )
      return { status: "not_found" };
    const store = isShogiRoom(room)
      ? this.standardShogiProgress.store()
      : this.shogiProgress.store();
    if (live) {
      const count = store.eventCount(roundId);
      // 観戦snapshotのrevisionを、そのまま欠落のないイベントprefixへ対応させます。
      if (room.status === "playing" && count !== room.positionRevision)
        throw new Error("Shogi revision and replay event count disagree");
      if (
        !Number.isSafeInteger(throughEventCount) ||
        !Number.isSafeInteger(cursor) ||
        cursor < 0 ||
        throughEventCount < cursor ||
        throughEventCount > count
      )
        return { status: "invalid_request" };
    }
    const page = store.getPage(instanceId, roundId, cursor, throughEventCount);
    return page ? { status: "found", page } : { status: "not_found" };
  }

  private publicMetadata(room: Room): RoomPublicMetadata & {
    instanceId: string;
    hostPlayerId: string | null;
    participantPreviews: IndexedRoomParticipant[];
  } {
    const host = room.players.find((player) => {
      if (player.kind !== "human" || player.retired) return false;
      const tokenHash = this.playerTokenHash(player.id);
      return tokenHash !== null && this.readMembership(tokenHash)?.role === "host";
    });
    const humanCount = room.players.filter((player) => player.kind === "human").length;
    return {
      instanceId: room.instanceId,
      hostPlayerId: host?.id ?? null,
      participantPreviews: room.players.map((player) => ({
        playerId: player.id,
        appearance:
          player.kind === "cpu"
            ? { kind: "cpu", level: player.level }
            : {
                kind: "human",
                avatarUrl: player.retired ? null : player.avatarUrl,
                ...(player.retired ? { retired: true as const } : {}),
              },
      })),
      ...roomPublicMetadataSchema.parse({
        id: room.id,
        ...(isFourShogiRoom(room) && room.tournamentId !== undefined
          ? { tournamentId: room.tournamentId }
          : {}),
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
    if ([...this.ctx.storage.kv.list({ prefix: pendingTournamentStatePrefix })].length)
      this.ctx.waitUntil(this.flushTournamentStates());
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
    this.trialCpu.maintain(room);
    const deadlines =
      room?.players
        .filter((player) => player.kind === "human" && !this.registrationForPlayer(player.id))
        .map((player) => player.reconnectDeadline)
        .filter((value) => value !== null) ?? [];
    if (room !== null) deadlines.push(room.lastActivityAtMs + idleMs);
    for (const player of room?.players ?? []) {
      const registration = this.registrationForPlayer(player.id);
      if (registration) deadlines.push(registration.holdUntilMs);
    }
    if (room?.status === "playing") {
      deadlines.push(room.clock.turnExpiresAt);
      if (currentCpu(room) !== null) {
        const job = isFourShogiRoom(room)
          ? this.ctx.storage.kv.get<ShogiCpuJob>(shogiCpuJobKey)
          : isShogiRoom(room)
            ? this.ctx.storage.kv.get<{ applyAt: number }>("standard-shogi-cpu-job")
            : isFourGomokuRoom(room)
              ? this.ctx.storage.kv.get<FourGomokuCpuJob>(fourGomokuCpuJobKey)
              : isGomokuRoom(room)
                ? this.ctx.storage.kv.get<GomokuCpuJob>(gomokuCpuJobKey)
                : isFourReversiRoom(room)
                  ? this.reversiProgress.cpuJob(room)
                  : undefined;
        const earliestCpuMoveAt = room.clock.turnStartedAt + cpuMoveDelayMs;
        const trialAt =
          isFourShogiRoom(room) && this.trialCpu.enabled(room) ? this.trialCpu.alarmAt(room) : null;
        deadlines.push(
          trialAt ?? (job ? Math.max(job.applyAt, earliestCpuMoveAt) : earliestCpuMoveAt),
        );
      }
    }
    const pending = this.ctx.storage.kv.get<PendingRoomIndex>(pendingIndexKey);
    if (pending !== undefined) deadlines.push(pending.retryAtMs);
    for (const job of this.ctx.storage.kv.get<AccountCleanup[]>(accountCleanupKey) ?? [])
      deadlines.push(job.retryAtMs);
    for (const job of this.pendingAnalytics().values()) deadlines.push(job.retryAtMs);
    for (const job of this.pendingMatches().values()) deadlines.push(job.retryAtMs);
    for (const job of this.pendingShogiMatches().values()) deadlines.push(job.retryAtMs);
    const claims = this.ctx.storage.kv.get<PendingGuestClaims>(guestClaimsKey);
    if (claims) deadlines.push(claims.retryAtMs);
    for (const [, job] of this.ctx.storage.kv.list<PendingTournamentState>({
      prefix: pendingTournamentStatePrefix,
    }))
      deadlines.push(job.retryAtMs);
    const tournament = this.tournamentReservation(room);
    if (tournament?.status === "waiting")
      deadlines.push(
        Math.min(
          tournament.preparedAtMs + tournamentRules.connectionGraceMs,
          tournament.context.endsAtMs,
        ),
      );
    if (room && isFourShogiRoom(room) && room.status === "waiting" && room.tournamentStartsAtMs)
      deadlines.push(room.tournamentStartsAtMs);
    const next = earliestAlarmAt(deadlines);
    const current = await this.ctx.storage.getAlarm();
    if (next === current) return;
    if (next === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next);
  }

  private tournamentReservation(room = this.readRoom()): TournamentRoomReservation | null {
    const matchId = this.ctx.storage.kv.get<string>(tournamentRoomKey);
    const reservation = matchId
      ? this.ctx.storage.kv.get<TournamentRoomReservation>(tournamentReservationKey(matchId))
      : undefined;
    return room && reservation?.instanceId === room.instanceId ? reservation : null;
  }

  private recordTournamentState(
    reservation: TournamentRoomReservation,
    phase: PendingTournamentState["phase"],
  ) {
    this.ctx.storage.kv.put(pendingTournamentStatePrefix + reservation.context.matchId, {
      reservation,
      phase,
      retryAtMs: Date.now(),
    } satisfies PendingTournamentState);
  }

  private async flushTournamentStates(): Promise<void> {
    if (this.tournamentStateFlush) return this.tournamentStateFlush;
    const flush = async () => {
      for (const [key, pending] of [
        ...this.ctx.storage.kv.list<PendingTournamentState>({
          prefix: pendingTournamentStatePrefix,
        }),
      ]) {
        if (pending.retryAtMs > Date.now()) continue;
        try {
          await writeTournamentState(this.env.APP_DB, pending);
          this.ctx.storage.transactionSync(() => {
            const current = this.ctx.storage.kv.get<PendingTournamentState>(key);
            if (current?.phase === pending.phase && current.retryAtMs === pending.retryAtMs)
              this.ctx.storage.kv.delete(key);
          });
        } catch {
          this.ctx.storage.transactionSync(() => {
            const current = this.ctx.storage.kv.get<PendingTournamentState>(key);
            if (current?.phase === pending.phase && current.retryAtMs === pending.retryAtMs)
              this.ctx.storage.kv.put(key, { ...current, retryAtMs: Date.now() + 5_000 });
          });
        }
      }
      await this.syncAlarm(this.readRoom());
    };
    this.tournamentStateFlush = flush().finally(() => {
      this.tournamentStateFlush = null;
    });
    return this.tournamentStateFlush;
  }

  async prepareTournamentRoom(input: PrepareTournamentRoomInput) {
    const parsed = prepareTournamentRoomSchema.safeParse(input);
    if (!parsed.success) return { status: "invalid_reservation" as const };
    await this.reconcileDeadlines();
    const { context, roomId, instanceId, players } = parsed.data;
    if (
      roomId !== this.ctx.id.name ||
      context.startsAtMs >= context.endsAtMs ||
      new Set(players.map((p) => p.admission.accountId)).size !== 4 ||
      new Set(players.map((p) => p.admission.playerId)).size !== 4 ||
      new Set(players.map((p) => p.tokenHash)).size !== 4 ||
      players.some((p) => p.admission.roomId !== roomId || p.admission.instanceId !== instanceId)
    )
      return { status: "invalid_reservation" as const };
    return this.ctx.blockConcurrencyWhile(async () => {
      const existing = this.ctx.storage.kv.get<TournamentRoomReservation>(
        tournamentReservationKey(context.matchId),
      );
      if (
        existing &&
        (existing.roomId !== roomId ||
          existing.instanceId !== instanceId ||
          JSON.stringify(existing.context) !== JSON.stringify(context))
      )
        return { status: "invalid_reservation" as const };
      if (existing)
        return {
          status:
            existing.status === "closed" ? ("cancelled" as const) : ("already_prepared" as const),
        };
      if (this.ctx.storage.kv.get(cancelledTournamentKey(context.matchId)))
        return { status: "cancelled" as const };
      if (this.readRoom()) return { status: "room_in_use" as const };
      const checks = await this.env.APP_DB.batch(
        players.map(({ admission }) =>
          this.env.APP_DB.prepare(`SELECT u.isTestUser FROM account_room_seats s
          JOIN user u ON u.id=s.account_id
          JOIN tournament_match_players p ON p.match_id=? AND p.account_id=s.account_id AND p.player_id=s.player_id AND p.operation_id=s.operation_id
          JOIN tournament_entries e ON e.id=p.entry_id AND e.account_id=s.account_id AND e.deleted=0
          JOIN tournament_matches m ON m.id=p.match_id AND m.tournament_key=e.tournament_key
          JOIN tournaments t ON t.key=m.tournament_key
          WHERE s.account_id=? AND s.operation_id=? AND s.room_id=? AND s.instance_id=? AND s.player_id=?
            AND s.name=? AND s.avatar_key IS ? AND u.profileCompleted=1
            AND m.phase='reserved' AND m.room_id=? AND m.instance_id=?
            AND t.key=? AND t.public_id=? AND t.published=1 AND t.rule_version=?
            AND t.starts_at_ms=? AND t.ends_at_ms=?
            AND NOT EXISTS(SELECT 1 FROM deleted_accounts d WHERE d.id=u.id)`).bind(
            context.matchId,
            admission.accountId,
            admission.operationId,
            roomId,
            instanceId,
            admission.playerId,
            admission.name,
            admission.avatarKey,
            roomId,
            instanceId,
            context.tournamentKey,
            context.tournamentId,
            tournamentRules.version,
            context.startsAtMs,
            context.endsAtMs,
          ),
        ),
      );
      if (
        checks.some((check) => check.results.length !== 1) ||
        Date.now() < context.startsAtMs ||
        Date.now() >= context.endsAtMs ||
        players.some(
          (p) =>
            this.ctx.storage.kv.get(cancelledAdmissionKey(p.admission.operationId)) ||
            this.readMembership(p.tokenHash),
        )
      )
        return { status: "invalid_reservation" as const };
      const now = Date.now();
      const base = waitingRoomFactories["four-shogi"]({
        code: roomId,
        name: players[0].admission.name,
        request: {
          game: tournamentRules.game,
          mode: tournamentRules.mode,
          quickPlay: false,
          timeControl: {
            mainTimeMs: tournamentRules.mainTimeMs,
            byoyomiMs: tournamentRules.byoyomiMs,
          },
          threePlayerAttackProhibited: tournamentRules.threePlayerAttackProhibited,
        },
      });
      const room = fourShogiRoomSchema.parse({
        ...base,
        instanceId,
        tournamentId: context.tournamentId,
        players: players.map(({ admission }) => ({
          id: admission.playerId,
          kind: "human",
          name: admission.name,
          avatarUrl: profileAvatarUrl(admission.avatarKey),
          ...(admission.isGuest ? { isGuest: true } : {}),
          ready: true,
          side: null,
          reconnectDeadline: Math.min(now + tournamentRules.connectionGraceMs, context.endsAtMs),
        })),
      });
      const reservation: TournamentRoomReservation = {
        context,
        roomId,
        instanceId,
        status: "waiting",
        preparedAtMs: now,
      };
      this.withIndexTransaction(() => {
        this.ctx.storage.kv.put(roomStorageKey, room);
        this.ctx.storage.kv.put(tournamentRoomKey, context.matchId);
        this.ctx.storage.kv.delete(tournamentReturnKey);
        this.ctx.storage.kv.put(tournamentReservationKey(context.matchId), reservation);
        for (const [index, { admission, tokenHash, credentialVersion }] of players.entries()) {
          this.ctx.storage.kv.put(accountKey(admission.playerId), {
            ...admission,
            occupying: true,
          });
          this.ctx.storage.kv.put(membershipStorageKey(tokenHash), {
            playerId: admission.playerId,
            role: index === 0 ? "host" : "player",
          });
          this.ctx.storage.kv.put(playerTokenKey(admission.playerId), tokenHash);
          this.ctx.storage.kv.put(
            tournamentCredentialVersionKey(admission.playerId),
            credentialVersion ?? 0,
          );
          this.ctx.storage.kv.put(disconnectedAtKey(admission.playerId), now);
          const profile = checks[index].results[0] as { isTestUser?: unknown };
          this.ctx.storage.kv.put(analyticsPlayerKey(admission.playerId), {
            accountId: admission.accountId,
            visitorId: null,
            isTest: Boolean(profile.isTestUser),
          });
          this.appendSystem("joined", `${admission.name}が入室しました`);
        }
        const secret = crypto.getRandomValues(new Uint8Array(32));
        this.ctx.storage.kv.put(viewerSecretKey, bytesToHex(secret));
      });
      await this.syncAlarm(room);
      return { status: "prepared" as const };
    });
  }

  async getTournamentReservationState(matchId: string) {
    await this.reconcileDeadlines();
    const reservation = this.ctx.storage.kv.get<TournamentRoomReservation>(
      tournamentReservationKey(matchId),
    );
    const room = this.readRoom();
    const connectedPlayerIds =
      reservation?.status === "waiting" && room?.instanceId === reservation.instanceId
        ? room.players
            .filter((player) => {
              const hash = this.playerTokenHash(player.id);
              return hash !== null && this.hasOpenConnection(hash);
            })
            .map((player) => player.id)
        : (reservation?.connectedPlayerIds ?? []);
    return reservation
      ? {
          status: reservation.status,
          connectedPlayerIds,
          ...(reservation.startedAtMs !== undefined
            ? { startedAtMs: reservation.startedAtMs }
            : {}),
        }
      : { status: "closed" as const, connectedPlayerIds: [] as string[] };
  }

  async abortTournamentRoom(matchId: string, excludedPlayerIds: string[] = []) {
    await this.reconcileDeadlines();
    const reservation = this.ctx.storage.kv.get<TournamentRoomReservation>(
      tournamentReservationKey(matchId),
    );
    if (reservation?.startedAtMs !== undefined) return { status: "already_started" as const };
    let closed = false;
    this.withIndexTransaction(() => {
      this.ctx.storage.kv.put(cancelledTournamentKey(matchId), true);
      const room = this.readRoom();
      if (reservation && room?.instanceId === reservation.instanceId) {
        this.ctx.storage.kv.put(tournamentReservationKey(matchId), {
          ...reservation,
          excludedPlayerIds: [
            ...new Set([...(reservation.excludedPlayerIds ?? []), ...excludedPlayerIds]),
          ],
        });
        this.closeRoom();
        closed = true;
      }
    });
    await this.syncAlarm(this.readRoom());
    if (closed) this.closeSockets();
    return { status: "cancelled" as const };
  }

  async rekeyTournamentPlayer(input: RekeyTournamentPlayerInput) {
    if (
      !Number.isInteger(input.version) ||
      input.version < 1 ||
      !/^[0-9a-f]{64}$/.test(input.tokenHash)
    )
      return { status: "stale" as const };
    let failure: unknown;
    const result = await this.ctx.blockConcurrencyWhile(async () => {
      try {
        const reservation = this.ctx.storage.kv.get<TournamentRoomReservation>(
          tournamentReservationKey(input.matchId),
        );
        const initial = this.readRoom();
        const seat = this.storedAccount(input.playerId);
        const resultWaiting =
          initial &&
          isFourShogiRoom(initial) &&
          initial.status === "waiting" &&
          initial.lastRound?.roundId === input.matchId &&
          reservation?.startedAtMs !== undefined;
        if (
          !reservation ||
          !initial ||
          !isFourShogiRoom(initial) ||
          initial.instanceId !== input.instanceId ||
          reservation.instanceId !== input.instanceId ||
          (reservation.status === "closed" && !resultWaiting) ||
          seat?.accountId !== input.accountId ||
          seat.operationId !== input.operationId ||
          !initial.players.some((player) => player.id === input.playerId)
        )
          return { status: "not_found" as const };
        const version =
          this.ctx.storage.kv.get<number>(tournamentCredentialVersionKey(input.playerId)) ?? 0;
        const previousHash = this.playerTokenHash(input.playerId);
        const collision = this.readMembership(input.tokenHash);
        if (collision && collision.playerId !== input.playerId) return { status: "stale" as const };
        if (
          input.version < version ||
          (input.version === version && previousHash !== input.tokenHash)
        )
          return { status: "stale" as const };
        if (input.version === version && previousHash === input.tokenHash)
          return { status: "updated" as const };
        const eligible = await this.env.APP_DB.prepare(
          `SELECT 1 FROM account_room_seats s JOIN user u ON u.id=s.account_id JOIN tournament_match_players p ON p.operation_id=s.operation_id AND p.match_id=? JOIN tournament_entries e ON e.id=p.entry_id AND e.account_id=s.account_id AND e.deleted=0 WHERE s.account_id=? AND s.operation_id=? AND s.instance_id=? AND s.player_id=? AND u.profileCompleted=1 AND NOT EXISTS(SELECT 1 FROM deleted_accounts d WHERE d.id=u.id)`,
        )
          .bind(input.matchId, input.accountId, input.operationId, input.instanceId, input.playerId)
          .first();
        if (!eligible) return { status: "not_found" as const };
        if (
          reservation.status === "waiting" &&
          Date.now() >=
            Math.min(
              reservation.preparedAtMs + tournamentRules.connectionGraceMs,
              reservation.context.endsAtMs,
            )
        ) {
          this.withIndexTransaction(() => this.closeRoom());
          this.closeSockets();
          return { status: "not_found" as const };
        }
        this.withIndexTransaction(() => {
          const membership = previousHash ? this.readMembership(previousHash) : null;
          if (previousHash) this.ctx.storage.kv.delete(membershipStorageKey(previousHash));
          this.ctx.storage.kv.put(
            membershipStorageKey(input.tokenHash),
            membership ?? {
              playerId: input.playerId,
              role: initial.players[0]?.id === input.playerId ? "host" : "player",
            },
          );
          this.ctx.storage.kv.put(playerTokenKey(input.playerId), input.tokenHash);
          this.ctx.storage.kv.put(tournamentCredentialVersionKey(input.playerId), input.version);
          this.ctx.storage.kv.put(disconnectedAtKey(input.playerId), Date.now());
          const { tournamentStartsAtMs: _deadline, ...waiting } =
            initial.status === "waiting"
              ? initial
              : { ...initial, tournamentStartsAtMs: undefined };
          const next = fourShogiRoomSchema.parse({
            ...waiting,
            publicUpdatedAtMs: nextPublicUpdateAt(initial),
            players: initial.players.map((player) =>
              player.id === input.playerId
                ? {
                    ...player,
                    reconnectDeadline:
                      player.reconnectDeadline ??
                      (reservation.status === "waiting"
                        ? Math.min(
                            reservation.preparedAtMs + tournamentRules.connectionGraceMs,
                            reservation.context.endsAtMs,
                          )
                        : Date.now() + reconnectGraceMs),
                  }
                : player,
            ),
          });
          this.ctx.storage.kv.put(roomStorageKey, next);
        });
        if (previousHash) {
          const notice: TournamentReturn = {
            type: "room.tournament.return",
            tournamentId: reservation.context.tournamentId,
            matchId: input.matchId,
            instanceId: input.instanceId,
            reason: "transferred",
          };
          for (const socket of this.ctx.getWebSockets()) {
            const attachment = socket.deserializeAttachment() as { tokenHash?: string } | null;
            if (attachment?.tokenHash === previousHash && socket.readyState === WebSocket.OPEN) {
              try {
                socket.send(JSON.stringify(notice));
              } catch {
                /* 切断済みなら新しい資格だけを有効にします。 */
              }
            }
          }
          this.closeSockets(previousHash, "Tournament control transferred");
        }
        const room = this.readRoom();
        await this.syncAlarm(room);
        if (room) this.broadcastRoom(room);
        return { status: "updated" as const };
      } catch (error) {
        // RPCの一時失敗で、ほかの参加者の接続までリセットしないようにします。
        failure = error;
        return null;
      }
    });
    if (result === null) throw failure;
    return result;
  }

  private tournamentPlayersConnected(room: FourShogiRoom): boolean {
    return (
      room.players.length === 4 &&
      room.players.every((player) => {
        const hash = this.playerTokenHash(player.id);
        return player.kind === "human" && !!hash && this.hasOpenConnection(hash);
      })
    );
  }

  private async advanceTournamentStart() {
    const initial = this.readRoom();
    const reservation = this.tournamentReservation(initial);
    if (
      !reservation ||
      reservation.status !== "waiting" ||
      !initial ||
      !isFourShogiRoom(initial) ||
      initial.status !== "waiting"
    )
      return;
    let countdownChanged = false;
    const countdown = this.withIndexTransaction(() => {
      const room = this.readRoom();
      if (!room || !isFourShogiRoom(room) || room.status !== "waiting") return null;
      const connected = this.tournamentPlayersConnected(room);
      if (connected && room.tournamentStartsAtMs !== undefined) return room;
      if (!connected && room.tournamentStartsAtMs === undefined) return null;
      const { tournamentStartsAtMs: _deadline, ...waiting } = room;
      const next = fourShogiRoomSchema.parse({
        ...waiting,
        ...(connected
          ? { tournamentStartsAtMs: Date.now() + tournamentRules.startCountdownMs }
          : {}),
        publicUpdatedAtMs: nextPublicUpdateAt(room),
      });
      this.ctx.storage.kv.put(roomStorageKey, next);
      countdownChanged = true;
      return next.status === "waiting" && connected ? next : null;
    });
    if (countdownChanged) {
      const room = this.readRoom();
      await this.syncAlarm(room);
      if (room) this.broadcastRoom(room);
    }
    if (
      countdown?.tournamentStartsAtMs === undefined ||
      countdown.tournamentStartsAtMs > Date.now()
    )
      return;
    await this.ctx.blockConcurrencyWhile(async () => {
      const active =
        await this.env.APP_DB.prepare(`SELECT COUNT(*) AS count FROM tournament_match_players p
        JOIN account_room_seats s ON s.account_id=p.account_id AND s.operation_id=p.operation_id AND s.player_id=p.player_id
        JOIN tournament_entries e ON e.id=p.entry_id AND e.account_id=p.account_id AND e.deleted=0
        JOIN user u ON u.id=p.account_id
        JOIN tournament_matches m ON m.id=p.match_id
        JOIN tournaments t ON t.key=m.tournament_key
        WHERE p.match_id=? AND m.phase='reserved' AND m.tournament_key=? AND m.room_id=? AND m.instance_id=?
          AND s.room_id=? AND s.instance_id=? AND u.profileCompleted=1
          AND t.published=1 AND t.public_id=? AND t.rule_version=? AND t.starts_at_ms=? AND t.ends_at_ms=?
          AND NOT EXISTS(SELECT 1 FROM deleted_accounts d WHERE d.id=p.account_id)`)
          .bind(
            reservation.context.matchId,
            reservation.context.tournamentKey,
            reservation.roomId,
            reservation.instanceId,
            reservation.roomId,
            reservation.instanceId,
            reservation.context.tournamentId,
            tournamentRules.version,
            reservation.context.startsAtMs,
            reservation.context.endsAtMs,
          )
          .first<{ count: number }>();
      const now = Date.now();
      if (
        active?.count !== 4 ||
        now < reservation.context.startsAtMs ||
        now >= reservation.context.endsAtMs ||
        now >= reservation.preparedAtMs + tournamentRules.connectionGraceMs
      ) {
        const closed = this.withIndexTransaction(() => {
          const room = this.readRoom();
          if (!room || room.instanceId !== reservation.instanceId) return false;
          this.closeRoom();
          return true;
        });
        if (closed) this.closeSockets();
        return;
      }
      this.withIndexTransaction(() => {
        const room = this.readRoom();
        if (
          !room ||
          !isFourShogiRoom(room) ||
          room.status !== "waiting" ||
          room.instanceId !== reservation.instanceId
        )
          return;
        if (!this.tournamentPlayersConnected(room)) {
          const { tournamentStartsAtMs: _deadline, ...waiting } = room;
          this.ctx.storage.kv.put(roomStorageKey, {
            ...waiting,
            publicUpdatedAtMs: nextPublicUpdateAt(room),
          });
          return;
        }
        if (
          room.tournamentStartsAtMs === undefined ||
          room.tournamentStartsAtMs !== countdown.tournamentStartsAtMs ||
          room.tournamentStartsAtMs > Date.now()
        )
          return;
        if (
          Date.now() >= reservation.context.endsAtMs ||
          Date.now() >= reservation.preparedAtMs + tournamentRules.connectionGraceMs
        ) {
          this.closeRoom();
          return;
        }
        const started = this.shogiProgress.start(room, reservation.context);
        const playing: TournamentRoomReservation = {
          ...reservation,
          status: "playing",
          startedAtMs: started.at,
        };
        this.ctx.storage.kv.put(tournamentReservationKey(reservation.context.matchId), playing);
        this.recordTournamentState(playing, "playing");
        this.startAnalyticsMatch(started.roundId, started.room, started.at);
      });
    });
    const room = this.readRoom();
    await this.syncAlarm(room);
    if (room) this.broadcastRoom(room);
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

  async getShareMetadata(instanceId: string) {
    // normalizeや期限処理を呼ばず、クローラーの取得で対局・時計・保存を変更しません。
    const parsed = roomSchema.safeParse(this.ctx.storage.kv.get(roomStorageKey));
    if (!parsed.success) return null;
    const room = parsed.data;
    const now = Date.now();
    if (room.instanceId !== instanceId || room.lastActivityAtMs + idleMs <= now) return null;
    const retained = room.players.some((player) => {
      if (!this.isHumanParticipant(player)) return false;
      if ((this.registrationForPlayer(player.id)?.holdUntilMs ?? 0) > now) return true;
      const hash = this.playerTokenHash(player.id);
      if (hash && this.hasOpenConnection(hash)) return true;
      const disconnectedAt = this.ctx.storage.kv.get<number>(disconnectedAtKey(player.id));
      const deadline =
        player.reconnectDeadline ??
        (disconnectedAt === undefined ? now + reconnectGraceMs : disconnectedAt + reconnectGraceMs);
      return deadline > now;
    });
    return retained
      ? { id: room.id, instanceId: room.instanceId, settings: { game: room.settings.game } }
      : null;
  }

  async getRoomSnapshot(formationAnalysis = false, stamps = false, eliminatedHands = false) {
    const room = await this.getRoom();
    return room === null
      ? null
      : {
          room,
          presence: this.presence(room),
          serverNowMs: Date.now(),
          ...roomFormationAnalysis(room, formationAnalysis),
          ...this.shogiProgress.displayHands(room, eliminatedHands),
          ...(stamps ? { stampsSupported: true as const } : {}),
        };
  }

  async resolvePlayerProfile(instanceId: string, playerId: string) {
    const room = await this.getRoom();
    if (!room) return { status: "not_found" as const };
    if (room.instanceId !== instanceId) return { status: "room_changed" as const };
    const player = room.players.find((p) => p.id === playerId);
    if (player?.kind === "human" && player.retired) return { status: "not_found" as const };
    if (!player) return { status: "not_found" as const };
    return {
      status: "found" as const,
      game: room.settings.game,
      player,
      accountId: this.storedAccount(playerId)?.accountId ?? null,
    };
  }

  async refreshLobbyIndex(expectedInstanceId: string | null, expectedRevision: number) {
    await this.reconcileDeadlines();
    const room = this.readRoom();
    if (room === null) {
      // 番号が再利用された後の行や、新しいrevisionは閉じません。
      await this.env.APP_DB.prepare(
        "UPDATE room_index SET closed=1 WHERE room_id=? AND instance_id IS ? AND revision=?",
      )
        .bind(this.ctx.id.name, expectedInstanceId, expectedRevision)
        .run();
      return;
    }
    this.ctx.storage.transactionSync(() => {
      const revision =
        Math.max(this.ctx.storage.kv.get<number>(indexRevisionKey) ?? 0, expectedRevision) + 1;
      this.ctx.storage.kv.put(indexRevisionKey, revision);
      this.ctx.storage.kv.put(pendingIndexKey, {
        revision,
        closed: false,
        metadata: this.publicMetadata(room),
        retryAtMs: Date.now(),
      } satisfies PendingRoomIndex);
    });
    await this.flushRoomIndex();
  }

  async getPublicMetadata(profilePreview = false) {
    await this.reconcileDeadlines();
    const room = this.readRoom();
    if (room === null) return null;
    const {
      instanceId,
      hostPlayerId,
      participantPreviews: _previews,
      ...metadata
    } = this.publicMetadata(room);
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
      ? { status: "found", membership: this.publicMembership(membership) }
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
    | { status: "tournament_required" }
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
        if (isFourShogiRoom(room) && room.tournamentId !== undefined)
          return { status: "tournament_required" } as const;
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
              ...(admission?.isGuest ? { isGuest: true } : {}),
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
    this.releaseRegistration(playerId);
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

  private closeSockets(tokenHash?: string, reason = "Room membership ended"): void {
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
          const attachment = socket.deserializeAttachment() as { tokenHash?: string } | null;
          const notice = attachment?.tokenHash
            ? this.ctx.storage.kv.get<Record<string, TournamentReturn>>(tournamentReturnKey)?.[
                attachment.tokenHash
              ]
            : undefined;
          if (notice) socket.send(JSON.stringify(notice));
          else this.sendSocketError(socket, "not_found");
        } catch {
          // 通知に失敗しても接続を終了します。
        }
      }
      try {
        socket.close(1000, reason);
      } catch {
        // 切断済みの接続は、そのまま無視します。
      }
    }
  }

  private async reconcileDeadlines(applyCpu = false): Promise<void> {
    const code = this.ctx.id.name ?? this.readRoom()?.id;
    if (code) {
      const pending = await this.env.APP_DB.prepare(
        "SELECT account_id FROM deletion_rooms WHERE room_id=?",
      )
        .bind(code)
        .all<{ account_id: string }>();
      for (const row of pending.results) {
        await this.purgeAccount(row.account_id);
        await this.env.APP_DB.prepare("DELETE FROM deletion_rooms WHERE room_id=? AND account_id=?")
          .bind(code, row.account_id)
          .run();
      }
    }
    const initial = this.readRoom();
    const now = Date.now();
    const promoted: string[] = [];
    let changed = false;
    const updated = this.withIndexTransaction(() => {
      // 将棋の読取りは従来どおりtransaction内。リバーシは最初の読取りを使用。
      let room: Room | null =
        initial && (isFourShogiRoom(initial) || isShogiRoom(initial)) ? this.readRoom() : initial;
      if (!room) return null;
      const tournament = this.tournamentReservation(room);
      if (
        tournament?.status === "waiting" &&
        isFourShogiRoom(room) &&
        room.status === "waiting" &&
        room.tournamentStartsAtMs !== undefined &&
        !this.tournamentPlayersConnected(room)
      ) {
        const { tournamentStartsAtMs: _deadline, ...waiting } = room;
        room = fourShogiRoomSchema.parse({
          ...waiting,
          publicUpdatedAtMs: nextPublicUpdateAt(room),
        });
        this.ctx.storage.kv.put(roomStorageKey, room);
        changed = true;
      }
      if (
        tournament?.status === "waiting" &&
        (now >=
          Math.min(
            tournament.preparedAtMs + tournamentRules.connectionGraceMs,
            tournament.context.endsAtMs,
          ) ||
          room.players.length !== 4)
      ) {
        this.closeRoom();
        changed = true;
        return null;
      }
      if (room.lastActivityAtMs + idleMs <= now || this.closeIfNoHumanParticipants(room) === null) {
        if (room.lastActivityAtMs + idleMs <= now) this.closeRoom();
        changed = true;
        return null;
      }
      const registrationPlayers = room.players.map((player) => {
        if (player.kind !== "human") return player;
        let registration = this.registrationForPlayer(player.id);
        if (registration && registration.holdUntilMs <= now) {
          this.endRegistration(registration, "expired");
          registration = null;
          changed = true;
        }
        if (player.registrationPendingUntilMs === registration?.holdUntilMs) return player;
        changed = true;
        const { registrationPendingUntilMs: _pending, ...rest } = player;
        return registration
          ? { ...rest, registrationPendingUntilMs: registration.holdUntilMs }
          : rest;
      });
      if (changed) {
        room = roomSchema.parse({ ...room, players: registrationPlayers });
        this.ctx.storage.kv.put(roomStorageKey, room);
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
          } else if (isFourGomokuRoom(room)) {
            const turn: "black" | "white" | "red" | "blue" = room.game.turn;
            const player: FourGomokuRoom["players"][number] | undefined = room.players.find(
              (p) => p.color === turn,
            );
            if (!player) throw Error("Missing timed-out player");
            room = this.applyProgress(
              this.fourGomokuProgress.eliminate(room, player.id, "timeout", deadline.at),
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
                : isFourGomokuRoom(room)
                  ? this.applyProgress(
                      this.fourGomokuProgress.eliminate(
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
            const trial = this.trialCpu.enabled(room);
            const proposal = trial
              ? { kind: "unchanged" as const }
              : this.shogiProgress.cpuDraw(room, now);
            if (proposal.kind !== "unchanged") {
              room = this.applyProgress(proposal);
              if (room) this.ctx.storage.kv.put(roomStorageKey, room);
              changed = true;
            }
            if (!room || room.status !== "playing") return room;
            if (!isFourShogiRoom(room)) throw new Error("Expected Shogi room");
            const result = trial ? this.trialCpu.cpu(room, now) : this.shogiProgress.cpu(room, now);
            if (result && result.kind !== "unchanged") {
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
        } else if (isFourGomokuRoom(room)) {
          if (applyCpu && currentCpu(room) !== null) {
            const result = this.fourGomokuProgress.cpu(room, now);
            if (result.kind !== "unchanged") {
              room = this.applyProgress(result);
              if (room) this.ctx.storage.kv.put(roomStorageKey, room);
              changed = true;
            }
          }
        } else if (isGomokuRoom(room)) {
          if (applyCpu && currentCpu(room) !== null) {
            const result = this.gomokuProgress.cpu(room, now);
            if (result.kind !== "unchanged") {
              room = this.applyProgress(result);
              if (room) this.ctx.storage.kv.put(roomStorageKey, room);
              changed = true;
            }
          }
        } else if (isFourReversiRoom(room)) {
          if (applyCpu && currentCpu(room) !== null) {
            const result = this.reversiProgress.cpu(room, now);
            if (result.kind !== "unchanged") {
              room = this.applyProgress(result);
              if (room) this.ctx.storage.kv.put(roomStorageKey, room);
              changed = true;
            }
          }
        } else {
          const result = this.standardProgress.cpu(room, now);
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
    if (applyCpu) this.trialCpu.kick();
    await this.flushRoomIndex();
    await this.flushAccountCleanup();
    await this.flushTournamentStates();
    if (!initial || !isFourShogiRoom(initial)) this.ctx.waitUntil(this.flushMatches());
    this.ctx.waitUntil(this.flushGuestMatchClaims());
    if (changed) {
      if (updated) this.broadcastRoom(updated);
      else this.closeSockets();
    }
    for (const hash of promoted) this.sendCurrentMembership(hash);
    await this.advanceTournamentStart();
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
        const tournament = this.tournamentReservation(room);
        if (tournament?.status === "waiting") {
          this.ctx.storage.kv.put(tournamentReservationKey(tournament.context.matchId), {
            ...tournament,
            excludedPlayerIds: [...new Set([...(tournament.excludedPlayerIds ?? []), player.id])],
          });
          this.closeRoom();
          return { status: "left" as const, room: null };
        }
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
      } else if (isFourGomokuRoom(room)) {
        this.recordDeparture(player);
        this.releaseAccount(player.id, false);
        const prepared = this.fourGomokuProgress.prepareLeave(room, player.id);
        this.ctx.storage.kv.delete(membershipStorageKey(tokenHash));
        this.ctx.storage.kv.delete(playerTokenKey(player.id));
        updated = this.applyProgress(
          this.fourGomokuProgress.leave(
            room,
            player.id,
            prepared,
            Date.now(),
            membership.role === "host",
          ),
        );
        if (updated) this.ctx.storage.kv.put(roomStorageKey, updated);
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
    const snapshots = new Map<string, string>();
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      try {
        const tags = this.ctx.getTags(socket);
        const formation = tags.includes(formationAnalysisTag);
        const hands = tags.includes(eliminatedHandsTag);
        const key = `${formation}:${hands}`;
        let message = snapshots.get(key);
        if (message === undefined) {
          message = JSON.stringify(this.roomSnapshot(room, formation, hands));
          snapshots.set(key, message);
        }
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

  private roomSnapshot(
    room: Room,
    formationAnalysis = false,
    eliminatedHands = false,
  ): RoomSocketMessage {
    return roomSocketContract.message.parse({
      type: "room.snapshot",
      room,
      presence: this.presence(room),
      serverNowMs: Date.now(),
      ...roomFormationAnalysis(room, formationAnalysis),
      ...this.shogiProgress.displayHands(room, eliminatedHands),
    });
  }

  private sendRoomSnapshot(socket: WebSocket, room: Room): void {
    socket.send(
      JSON.stringify(
        this.roomSnapshot(
          room,
          this.ctx.getTags(socket).includes(formationAnalysisTag),
          this.ctx.getTags(socket).includes(eliminatedHandsTag),
        ),
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
      membership: this.publicMembership(membership),
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
    | { status: "registration_pending" }
    | { status: "already_started" } {
    return this.withIndexTransaction(() => {
      const room = this.readRoom();
      if (room === null) return { status: "not_found" };
      if (room.status !== "waiting") return { status: "already_started" };

      const membership = this.readMembership(tokenHash);
      if (membership === null) return { status: "unauthorized" };
      const player = room.players.find((entry) => entry.id === membership.playerId);
      if (player === undefined) return { status: "unauthorized" };
      if (this.registrationForPlayer(player.id)) return { status: "registration_pending" };
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

  private applySettings(
    tokenHash: string,
    command: Extract<RoomSocketClientMessage, { type: "room.settings.apply" }>,
  ) {
    return this.withIndexTransaction(() => {
      const room = this.readRoom();
      if (!room) return { status: "not_found" as const };
      if (this.readMembership(tokenHash)?.role !== "host") return { status: "forbidden" as const };
      const result = prepareRoomSettings(room, command);
      if (result.status !== "updated") return result;
      if (command.mode !== undefined && command.mode !== room.settings.mode)
        this.appendSystem(
          "mode_changed",
          `対局形式が${command.mode === "singles" ? "シングルス" : "ダブルス"}に変更されました`,
        );
      for (const player of room.players)
        if (
          player.kind === "cpu" &&
          !result.room.players.some((current) => current.id === player.id)
        )
          this.recordDeparture(player);
      for (const player of result.room.players)
        if (player.kind === "cpu" && !room.players.some((previous) => previous.id === player.id))
          this.appendSystem("joined", `CPU Lv${player.level}が入室しました`);
      this.ctx.storage.kv.put(roomStorageKey, result.room);
      return result;
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

  private startGame(tokenHash: string):
    | { status: "started"; room: Room }
    | {
        status:
          | "not_found"
          | "unauthorized"
          | "forbidden"
          | "not_ready"
          | "already_started"
          | "registration_pending";
      } {
    return this.withIndexTransaction(() => {
      const room = this.readRoom();
      if (room === null) return { status: "not_found" };
      if (room.status !== "waiting") return { status: "already_started" };

      const membership = this.readMembership(tokenHash);
      if (membership === null) return { status: "unauthorized" };
      if (membership.role !== "host") return { status: "forbidden" };
      if (room.players.some((player) => this.registrationForPlayer(player.id)))
        return { status: "registration_pending" };
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
          : isFourGomokuRoom(room)
            ? this.fourGomokuProgress.start(room)
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
      if (
        isFourGomokuRoom(room) ||
        isGomokuRoom(room) ||
        isFourShogiRoom(room) ||
        isShogiRoom(room)
      )
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
          : isFourGomokuRoom(room)
            ? this.fourGomokuProgress.resign(room, tokenHash)
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
      ...(query.data.eliminatedHands === "1" ? [eliminatedHandsTag] : []),
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
        await this.advanceTournamentStart();
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

      const tournamentRoom = this.readRoom();
      if (
        tournamentRoom &&
        isFourShogiRoom(tournamentRoom) &&
        tournamentRoom.tournamentId !== undefined &&
        [
          "room.ready.set",
          "room.settings.apply",
          "room.three-player-attack.set",
          "room.time-control.set",
          "room.mode.set",
          "room.cpu.add",
          "room.cpu.remove",
          "room.cpu.level.set",
          "room.game.start",
          "room.game.draw.set",
        ].includes(parsed.data.type)
      ) {
        this.rejectAction(socket, "forbidden");
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

      if (parsed.data.type === "room.settings.apply") {
        const result = this.applySettings(tokenHash.data, parsed.data);
        if (result.status === "updated") this.broadcastRoom(result.room);
        else if (result.status === "unchanged") {
          const room = this.readRoom();
          if (room) this.sendRoomSnapshot(socket, room);
        } else this.rejectAction(socket, result.status);
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
            ? command.action.type === "placeFourGomokuStone"
              ? this.playFourGomoku(tokenHash.data, {
                  type: "room.game.action",
                  action: command.action,
                  roundId: command.roundId,
                  positionRevision: command.positionRevision,
                })
              : command.action.type === "placeGomokuStone"
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
