import {
  tournamentReservation,
  recordTournamentState,
  updatePendingTournamentState,
  getTournamentReservationState,
  abortTournamentRoom,
} from "../../flows/tournamentRoom/reservations";
import { prepareTournamentRoom } from "../../flows/tournamentRoom/prepare";
import { rekeyTournamentPlayer } from "../../flows/tournamentRoom/rekey";
import {
  tournamentPlayersConnected,
  advanceTournamentStart,
} from "../../flows/tournamentRoom/start";
import { hasOpenConnection, sendCurrentMembership } from "./socket/membership";
import type { RoomRuntime, RoomSocketError } from "./runtime";
import {
  accountKey,
  cancelledAdmissionKey,
  membershipStorageKey,
  playerTokenKey,
  chatKey,
  mutedKey,
  viewerSecretKey,
  disconnectedAtKey,
  lastChatAtKey,
  reconnectGraceMs,
} from "./storageKeys";
import { bytesToHex } from "./tokenCrypto";
import { appendSystem, broadcastChat } from "./chat";
import { presence, broadcastRoom } from "./snapshots";
import { closeSockets, webSocketClose, webSocketError } from "./connections";
import { issueViewerToken } from "./viewerTokens";
import { inspectReport, moderateMessage } from "./reports";
import { fetch } from "./fetch";
import { webSocketMessage } from "./socket/message";
import {
  matchmakingRoomConfiguration,
  matchmakingCpuAppearance,
  matchmakingRoomMetadata,
} from "../../rooms/gameAdapters/matchmaking";
import {
  currentRoomStateVersion,
  roomStateVersionKey,
  migrateRoomStateV0ToV1,
} from "../../rooms/roomStateVersion";
import { matchEndFacts } from "../../usageEvents/matchLifecycle";
import { roomMatchKind, type MatchKind } from "@tetraboard/protocol";
import { logFourShogiDiagnostic } from "../../fourShogiDiagnostics";
import { TransactionUsageEvents } from "../../usageEvents/transactionEvents";
import { RoomJob } from "../../rooms/roomJobs";
import {
  cpuReferenceRating,
  hasProfileRating,
  profileRatingsKey,
  readProfileRating,
} from "../../accounts/profileRatings";
import type { ProfileRatings } from "@tetraboard/protocol";
import {
  cpuPlayerAppearance,
  isRatedMatchmakingGame,
  matchmakingRules,
} from "@tetraboard/protocol";
import type {
  MatchmakingRoomInput,
  MatchmakingRoomReservation,
} from "../../matchmaking/coordinator";
import { isTournamentGameRoom } from "../../rooms/tournamentRoom";
import { prepareRoomSettings } from "../../rooms/applyRoomSettings";
import { shogiEliminatedHandsKey, fourShogiAiJobKey } from "../../rooms/fourShogiProgress";
import { retiredName } from "../../privacy/identity";
import type { PendingMatch as PendingFourGomokuMatch } from "../../rooms/fourGomokuMatchStore";
import { fourGomokuCpuJobKey } from "../../rooms/fourGomokuProgress";
import type { FourGomokuRoom } from "@tetraboard/protocol";
import { gomokuCpuJobKey } from "../../rooms/gomokuProgress";
import type { GomokuRoom } from "@tetraboard/protocol";
import type { PendingMatch as PendingGomokuMatch } from "../../rooms/gomokuMatchStore";
import type { ShogiRoom } from "@tetraboard/protocol";
import {
  pendingStandardShogiMatchPrefix,
  standardShogiMatchStartKey,
  type PendingStandardShogiMatch,
} from "../../rooms/shogiMatchStore";
import type { ReversiRoom } from "@tetraboard/protocol";
import type { PendingMatch as PendingReversiMatch } from "../../rooms/reversiMatchStore";
import { gameCapacity } from "@tetraboard/protocol/games";
import { nextDueRoomDeadline } from "../../rooms/roomDeadlines";
import { nextRoomAlarmAt } from "../../rooms/roomAlarm";
import { RoomAlarmEvents, wrapRoomAlarmEvents } from "../../rooms/roomAlarmEvents";
import { roomFormationAnalysis } from "../../rooms/fourShogiFormationAnalysis";
import {
  analyticsActiveKey,
  analyticsPlayerKey,
  type AnalyticsIdentity,
  type AnalyticsMatch,
} from "../../usageEvents/matches";
import {
  joinRoomContract,
  membershipTokenSchema,
  roomMembershipSchema,
  roomPublicMetadataSchema,
  tournamentRules,
  roomSchema,
  type FourShogiRoom,
  type FourReversiRoom,
  type Room,
  type RoomMembership,
  type RoomTimeControl,
  type RoomPublicMetadata,
  type RoomSocketClientMessage,
} from "@tetraboard/protocol";
import { unreachable, type ProgressFor } from "../../rooms/gameProgress";
import { createGameAdapters } from "../../rooms/gameAdapters";
import type { GameAdapter, SettingsCommand, ActionCommand } from "../../rooms/gameAdapters/types";
import type { GameId } from "@tetraboard/protocol";
import type { ExternalCpuRequest } from "../../rooms/gameAdapters/cpuTypes";
import { fourReversiCpuJobKey, fourReversiAiJobKey } from "../../rooms/fourReversiProgress";
import { requestRatedAiWarmup, type RatedAiGame } from "../../rooms/aiService";
import type { CpuCapacityGame } from "../../rooms/cpuCapacity";
import {
  roomStorageKey,
  replayKey,
  shogiCpuJobKey,
  cpuMoveDelayMs,
  nextPublicUpdateAt,
  playerLabel,
} from "../../rooms/progressHelpers";
import {
  advanceShogiMatchSave,
  pendingShogiMatchPrefix,
  shogiMatchStartKey,
  type PendingShogiMatch,
} from "../../rooms/shogiMatchStore";
import { profileAvatarUrl } from "../../accounts/auth";
import { retryPendingMatchClaims } from "../../accounts/matchClaims";
import { readStoredMatch } from "../../accounts/matchDataContracts";
import { releaseReservation, type AccountAdmission } from "../../accounts/roomAccounts";
import { DurableObject } from "cloudflare:workers";
import { waitingRoomFactories } from "../../rooms/waitingRoomFactories";
import {
  tournamentRoomKey,
  tournamentReservationKey,
  tournamentCredentialVersionKey,
  pendingTournamentStatePrefix,
  tournamentReturnKey,
  writeTournamentState,
  type PrepareTournamentRoomInput,
  type PendingTournamentState,
  type RekeyTournamentPlayerInput,
  type TournamentReturn,
} from "../../rooms/tournamentRoom";
import { isClockExpired } from "../../rooms/clock";
import {
  writeRoomIndex,
  type IndexedRoomParticipant,
  type PendingRoomIndex,
} from "../../rooms/roomIndex";
import {
  matchStartKey,
  pendingMatchPrefix,
  writeMatch,
  type PendingMatch,
} from "../../rooms/matchStore";
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
} from "../../rooms/registrationTypes";

const aiWarmupAttemptMs = 8000;
const aiWarmupRetryMs = 2000;
const aiWarmupMaxAttempts = 2;
const cpuCapacityKey = "external-cpu-capacity";
const cpuCapacitySequenceKey = "external-cpu-capacity-sequence";
type RoomCpuCapacity = {
  roomId: string;
  sequence: number;
  game: CpuCapacityGame;
  instanceId: string;
  // nullは準備済み・進行中の予約です。時刻がある予約は解放を再試行します。
  releaseAtMs: number | null;
};

const accountCleanupKey = "account-cleanups";
const guestClaimsKey = "guest-match-claims-pending";
type PendingGuestClaims = { generation: string; retryAtMs: number };
type StoredAccountSeat = AccountAdmission & { occupying: boolean };
type AccountCleanup = { reservation: AccountAdmission; releaseAvatar: boolean; retryAtMs: number };
const indexRevisionKey = "room-index-revision";
const pendingIndexKey = "room-index-pending";
const idleMs = 24 * 60 * 60 * 1000;
const departedKey = (playerId: string) => `departed:${playerId}`;
export class GameRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // フェーズ 6 の掃除で消す。旧計測の保存待ちだけを初回起動時に削除します。
    ctx.blockConcurrencyWhile(async () => {
      if (ctx.storage.kv.get("legacy-analytics-purged")) return;
      ctx.storage.transactionSync(() => {
        for (const [key] of ctx.storage.kv.list({ prefix: "analytics-pending:" }))
          ctx.storage.kv.delete(key);
        ctx.storage.kv.delete("analytics-player-aliases");
        ctx.storage.kv.put("legacy-analytics-purged", true);
      });
    });
  }

  private readonly alarmEvents = new RoomAlarmEvents(
    this,
    this.ctx.storage,
    () => this.nextAlarmAt(),
    (task) => this.ctx.waitUntil(task),
  );
  private readonly chat = { dirty: false };
  private readonly usageEvents = new TransactionUsageEvents(() => this.env.USAGE_EVENTS);
  private readonly progressDependencies = {
    storage: this.ctx.storage,
    membership: (hash: string) => this.readMembership(hash),
    accountId: (playerId: string) => this.storedAccount(playerId)?.accountId ?? null,
  };
  private readonly adapters = createGameAdapters({
    ...this.progressDependencies,
    aiService: () => this.env,
    appendSystem: (event, text) => appendSystem(this.runtime, event, text),
    recordDeparture: (player) => this.recordDeparture(player),
    logFourShogiDiagnostic: (event, fields) => logFourShogiDiagnostic(this.env, event, fields),
  });

  private gameAdapter<G extends GameId>(room: { settings: { game: G } }): GameAdapter<G> {
    const game = room.settings.game;
    const adapters: { [K in GameId]: GameAdapter<K> } = this.adapters;
    switch (game) {
      case "four-gomoku":
      case "gomoku":
      case "four-reversi":
      case "reversi":
      case "four-shogi":
      case "shogi":
        return adapters[game];
      default:
        return unreachable(game);
    }
  }

  private readonly runtime: RoomRuntime = {
    ctx: this.ctx,
    db: this.env.APP_DB,
    syncAlarm: () => this.alarmEvents.sync(),
    closeRoom: () => this.closeRoom(),
    storedAccount: (playerId) => this.storedAccount(playerId),
    startAnalyticsMatch: (id, room, at) => this.startAnalyticsMatch(id, room, at),
    chat: this.chat,
    readRoom: () => this.readRoom(),
    readMembership: (hash) => this.readMembership(hash),
    publicMembership: (membership) => this.publicMembership(membership),
    playerTokenHash: (playerId) => this.playerTokenHash(playerId),
    isHumanParticipant: (player) => this.isHumanParticipant(player),
    withIndexTransaction: (action, previousRoom) => this.withIndexTransaction(action, previousRoom),
    reconcileDeadlines: (applyCpu) => this.reconcileDeadlines(applyCpu),
    currentRoomMembership: (hash) => this.currentRoomMembership(hash),
    advanceTournamentStart: () => advanceTournamentStart(this.runtime),
    advanceMatchmakingStart: () => this.advanceMatchmakingStart(),
    gameAdapter: (room) => this.gameAdapter(room),
    setReady: (hash, ready) => this.setReady(hash, ready),
    applySettings: (hash, command) => this.applySettings(hash, command),
    updateGameSettings: (hash, command) => this.updateGameSettings(hash, command),
    setTimeControl: (hash, timeControl) => this.setTimeControl(hash, timeControl),
    startGame: (hash) => this.startGame(hash),
    setShogiDrawProposal: (hash, command) => this.setShogiDrawProposal(hash, command),
    declareShogi: (hash, command) => this.declareShogi(hash, command),
    resign: (hash) => this.resign(hash),
    play: (hash, command) => this.play(hash, command),
  };

  private clearMatchmakingSearches(reservation: MatchmakingRoomReservation) {
    return {
      ...reservation,
      players: reservation.players.map(({ search: _search, ...player }) => player),
    };
  }

  private startAnalyticsMatch(id: string, room: Room, at: number) {
    const reservation =
      "matchmaking" in room && room.matchmaking
        ? this.ctx.storage.kv.get<MatchmakingRoomReservation>(`matchmaking:${room.matchmaking.id}`)
        : undefined;
    const record: AnalyticsMatch = {
      id,
      matchKind: roomMatchKind(room),
      humanCount: room.players.filter((p) => p.kind === "human").length,
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
          const search = reservation?.players.find(
            (player) => player.admission.playerId === p.id,
          )?.search;
          const playerId =
            identity && !identity.accountId && !identity.visitorId ? crypto.randomUUID() : p.id;
          return {
            ...(search
              ? { search: { operationId: search.operationId, joinedAtMs: search.joinedAtMs } }
              : {}),
            playerId,
            visitorId: identity?.visitorId ?? null,
            accountId: identity
              ? identity.accountId
              : (this.storedAccount(p.id)?.accountId ?? null),
            isTest: identity?.isTest ?? search?.isTest ?? false,
            isGuest: identity?.isGuest ?? this.storedAccount(p.id)?.isGuest ?? false,
          };
        }),
    };
    const usage = this.usageEvents.writer();
    const common = {
      game: record.game,
      matchId: record.id,
      isTest: record.participants.length > 0 && record.participants.every((p) => p.isTest),
    };
    usage.write({
      ...common,
      name: "match_started",
      mode: record.mode,
      matchKind: record.matchKind ?? "unknown",
      humans: record.humanCount ?? record.participants.length,
      cpus: record.cpuCount,
    });
    for (const participant of record.participants) {
      const identity = {
        game: record.game,
        browserId: participant.visitorId,
        accountId: participant.accountId,
        isTest: participant.isTest,
      };
      usage.write({
        ...identity,
        name: "match_participant",
        matchId: record.id,
        isGuest: participant.isGuest ?? false,
      });
      if (participant.accountId && participant.search)
        usage.write({
          ...identity,
          name: "matchmaking",
          operationId: participant.search.operationId,
          stage: "started",
          reason: null,
          rated: record.matchKind === "rated",
          humans: record.humanCount ?? record.participants.length,
        });
    }
    if (reservation)
      this.ctx.storage.kv.put(
        `matchmaking:${reservation.matchId}`,
        this.clearMatchmakingSearches(reservation),
      );
    this.ctx.storage.kv.put(analyticsActiveKey, record);
  }

  private endAnalyticsMatch(
    status: "completed" | "abandoned",
    at: number,
    facts?: ReturnType<typeof matchEndFacts>,
  ) {
    const active = this.ctx.storage.kv.get<AnalyticsMatch>(analyticsActiveKey);
    if (!active) return;
    this.ctx.storage.kv.delete(analyticsActiveKey);
    this.usageEvents.writer().write({
      name: "match_ended",
      game: active.game,
      matchId: active.id,
      isTest: active.participants.length > 0 && active.participants.every((p) => p.isTest),
      result: status,
      reason: status === "abandoned" ? "abandoned" : (facts?.reason ?? "unknown"),
      durationMs: Math.max(0, at - active.startedAtMs),
    });
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
  private readonly shogiMatchJob = new RoomJob(this.alarmEvents, {
    pending: () => this.pendingShogiMatches(),
    retryAt: ([, job]) => job.retryAtMs,
    mode: "single",
    syncWhenEmpty: true,
    execute: ([, job]) =>
      advanceShogiMatchSave(
        this.env.APP_DB,
        job.record,
        job.progress,
        (cursor) => this.gameAdapter(job.record).replayEvents(job.record.id, cursor),
        "formationUsage" in job ? job.formationUsage : undefined,
        "tournament" in job ? job.tournament : undefined,
      ),
    complete: ([key, job], progress) =>
      this.ctx.storage.transactionSync(() => {
        const latest = this.pendingShogiMatches().get(key);
        if (!latest) return;
        if (progress)
          this.ctx.storage.kv.put(key, { ...latest, progress, retryAtMs: Date.now() + 1 });
        else {
          this.ctx.storage.kv.delete(key);
          const room = this.readRoom();
          const keep = Boolean(room && this.gameAdapter(room).keepsArchive(room, job.record.id));
          this.gameAdapter(job.record).releaseArchive(job.record.id, keep);
        }
      }),
    retry: ([key, job], retryAtMs) => {
      console.error("Shogi match save will be retried", job.record.id);
      const latest = this.pendingShogiMatches().get(key);
      if (latest) this.ctx.storage.kv.put(key, { ...latest, retryAtMs });
    },
  });

  private readonly matchJob = new RoomJob(this.alarmEvents, {
    pending: () => this.pendingMatches(),
    retryAt: ([, job]) => job.retryAtMs,
    execute: ([, job]) =>
      writeMatch(this.env.APP_DB, job.record, "tournament" in job ? job.tournament : undefined),
    complete: ([key]) => {
      this.ctx.storage.kv.delete(key);
    },
    retry: ([key, job], retryAtMs) => {
      console.error("Match save will be retried", job.record.id);
      const latest = this.pendingMatches().get(key);
      if (latest) this.ctx.storage.kv.put(key, { ...latest, retryAtMs });
    },
  });

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
      await this.alarmEvents.sync();
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
        await this.alarmEvents.sync();
        const retained = await this.env.APP_DB.prepare(
          "SELECT player_id FROM privacy_room_players WHERE account_id=? AND room_id=?",
        )
          .bind(accountId, code)
          .all<{ player_id: string }>();
        for (const row of retained.results) ids.add(row.player_id);
        await this.alarmEvents.sync();
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
          closeSockets(this.runtime, token, "Account deleted");
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
          (row.admission !== null &&
            typeof row.admission === "object" &&
            accountIds.has(String((row.admission as Record<string, unknown>).accountId))) ||
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
            key === "profileRatings" && v && typeof v === "object"
              ? Object.fromEntries(Object.entries(v).filter(([id]) => !matchingIds.has(id)))
              : own && ["name", "senderName", "hostName"].includes(key)
                ? retiredName
                : own &&
                    [
                      "accountId",
                      "avatarUrl",
                      "avatarKey",
                      "avatarPresetId",
                      "profileId",
                      "hostAvatarUrl",
                    ].includes(key)
                  ? null
                  : strip(v, own && key === "appearance", scope),
          ]),
        );
        if (own && row.kind === "human") out.retired = true;
        if (own && "visitorId" in row) out.visitorId = null;
        if (own && "search" in row) delete out.search;
        return out;
      };
      for (const [key, value] of entries) {
        if (removedKeys.has(key)) continue;
        if (key.startsWith("profile-ratings:") && value && typeof value === "object") {
          this.ctx.storage.kv.put(
            key,
            Object.fromEntries(Object.entries(value).filter(([id]) => !ids.has(id))),
          );
          continue;
        }
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
      if (room) broadcastRoom(this.runtime, room);
      broadcastChat(this.runtime);
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
      await this.alarmEvents.sync();
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
    this.alarmEvents.mark();
    this.ctx.waitUntil(this.guestClaimsJob.flush());
  }

  private readonly guestClaimsJob = new RoomJob(this.alarmEvents, {
    canRun: () => Boolean(this.ctx.id.name),
    syncOnlyWhenDue: true,
    pending: () => {
      const job = this.ctx.storage.kv.get<PendingGuestClaims>(guestClaimsKey);
      return job ? [job] : [];
    },
    retryAt: (job) => job.retryAtMs,
    mode: "single",
    execute: async () => {
      const code = this.ctx.id.name!;
      await retryPendingMatchClaims(this.env.APP_DB, code);
      return Boolean(
        await this.env.APP_DB.prepare(
          "SELECT 1 FROM match_participant_accounts WHERE room_id=? AND state='pending' LIMIT 1",
        )
          .bind(code)
          .first(),
      );
    },
    complete: (job, pending) => this.finishGuestClaims(job, pending ? Date.now() + 5_000 : null),
    retry: (job, retryAtMs) => {
      console.error("Guest match claims will be retried");
      this.finishGuestClaims(job, retryAtMs);
    },
  });

  private finishGuestClaims(job: PendingGuestClaims, retryAtMs: number | null) {
    this.ctx.storage.transactionSync(() => {
      const latest = this.ctx.storage.kv.get<PendingGuestClaims>(guestClaimsKey);
      if (latest?.generation !== job.generation) return;
      if (retryAtMs !== null) this.ctx.storage.kv.put(guestClaimsKey, { ...job, retryAtMs });
      else this.ctx.storage.kv.delete(guestClaimsKey);
    });
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
          previous.newTokenHash !== input.newTokenHash ||
          previous.guestAccountId !== input.guestAccountId
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
            record.guestAccountId === input.guestAccountId &&
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
      const seat = this.storedAccount(player.id);
      if (
        input.guestAccountId
          ? seat?.accountId !== input.guestAccountId || !seat.isGuest || !seat.occupying
          : seat !== null
      )
        return { status: "not_guest" };
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
    if (room && result.status === "started") broadcastRoom(this.runtime, room);
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
        const existing = this.storedAccount(record.playerId);
        if (
          membership?.playerId !== record.playerId ||
          (record.guestAccountId
            ? existing?.accountId !== record.guestAccountId ||
              !existing.isGuest ||
              !existing.occupying ||
              existing.operationId !== admission.operationId
            : existing !== null)
        )
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
        const avatarUrl = profileAvatarUrl(admission.avatarKey, admission.avatarPresetId);
        this.ctx.storage.kv.put(
          roomStorageKey,
          roomSchema.parse({
            ...room,
            publicUpdatedAtMs: nextPublicUpdateAt(room),
            lastActivityAtMs: now,
            players: room.players.map((p) => {
              if (p.id !== record.playerId || p.kind !== "human") return p;
              const { registrationPendingUntilMs: _pending, isGuest: _guest, ...player } = p;
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
      closeSockets(this.runtime, record.oldTokenHash, "Room membership updated");
      const room = this.readRoom();
      if (room) broadcastRoom(this.runtime, room);
    } else await this.reconcileDeadlines();
    return result ?? { status: "account_reservation_invalid" };
  }

  private queueAccountCleanup(reservation: AccountAdmission, releaseAvatar: boolean) {
    const jobs = this.ctx.storage.kv.get<AccountCleanup[]>(accountCleanupKey) ?? [];
    const existing = jobs.find((job) => job.reservation.operationId === reservation.operationId);
    if (existing) existing.releaseAvatar ||= releaseAvatar;
    else jobs.push({ reservation, releaseAvatar, retryAtMs: Date.now() });
    this.ctx.storage.kv.put(accountCleanupKey, jobs);
    this.alarmEvents.mark();
  }

  private releaseAccount(playerId: string, removeAvatar: boolean) {
    const seat = this.storedAccount(playerId);
    if (!seat) return;
    this.ctx.storage.kv.put(cancelledAdmissionKey(seat.operationId), true);
    this.queueAccountCleanup(seat, removeAvatar);
    if (removeAvatar) this.ctx.storage.kv.delete(accountKey(playerId));
    else this.ctx.storage.kv.put(accountKey(playerId), { ...seat, occupying: false });
  }

  private readonly accountCleanupJob = new RoomJob(this.alarmEvents, {
    pending: () => this.ctx.storage.kv.get<AccountCleanup[]>(accountCleanupKey) ?? [],
    retryAt: (job) => job.retryAtMs,
    execute: (job) => releaseReservation(this.env, job.reservation, job.releaseAvatar),
    complete: (job) =>
      this.ctx.storage.transactionSync(() => {
        const jobs = this.ctx.storage.kv.get<AccountCleanup[]>(accountCleanupKey) ?? [];
        // D1の応答待ちに画像の解放が追加された場合は、次の実行へ残します。
        const latest = jobs.find(
          (entry) => entry.reservation.operationId === job.reservation.operationId,
        );
        if (latest && latest.releaseAvatar && !job.releaseAvatar) return;
        this.ctx.storage.kv.put(
          accountCleanupKey,
          jobs.filter((entry) => entry.reservation.operationId !== job.reservation.operationId),
        );
        this.ctx.storage.kv.delete(cancelledAdmissionKey(job.reservation.operationId));
      }),
    retry: (job, retryAtMs) => {
      console.error("Account seat cleanup will be retried");
      const jobs = this.ctx.storage.kv.get<AccountCleanup[]>(accountCleanupKey) ?? [];
      for (const entry of jobs)
        if (entry.reservation.operationId === job.reservation.operationId)
          entry.retryAtMs = retryAtMs;
      this.ctx.storage.kv.put(accountCleanupKey, jobs);
    },
  });

  private async withAccountAdmission<T>(
    admission: AccountAdmission | undefined,
    action: () => T,
  ): Promise<T | null> {
    if (!admission) return action();
    const outcome = await this.ctx.blockConcurrencyWhile(async () => {
      try {
        if (this.ctx.storage.kv.get(cancelledAdmissionKey(admission.operationId)))
          return { ok: true as const, value: null };
        await this.alarmEvents.sync();
        const reservation =
          await this.env.APP_DB.prepare(`SELECT operation_id FROM account_room_seats
        WHERE account_id = ? AND operation_id = ? AND room_id = ? AND instance_id = ? AND player_id = ? AND name = ? AND avatar_key IS ? AND avatar_preset_id IS ? AND NOT EXISTS (SELECT 1 FROM deleted_accounts d WHERE d.id=account_room_seats.account_id)`)
            .bind(
              admission.accountId,
              admission.operationId,
              this.ctx.id.name,
              admission.instanceId,
              admission.playerId,
              admission.name,
              admission.avatarKey,
              admission.avatarPresetId ?? null,
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
            player.avatarUrl === profileAvatarUrl(admission.avatarKey, admission.avatarPresetId),
        ) ||
          room.lastRound?.players.some(
            (player) =>
              player.id === admission.playerId &&
              player.appearance?.kind === "human" &&
              player.appearance.avatarUrl ===
                profileAvatarUrl(admission.avatarKey, admission.avatarPresetId),
          ));
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.kv.put(cancelledAdmissionKey(admission.operationId), true);
        this.queueAccountCleanup(admission, !avatarReferenced);
      });
      this.alarmEvents.mark();
      return { occupied: false, avatarReferenced: Boolean(avatarReferenced) };
    });
  }

  private readRoom(): Room | null {
    const saved = this.ctx.storage.kv.get<Room>(roomStorageKey);
    if (saved === undefined) return null;
    const version = this.ctx.storage.kv.get<number>(roomStateVersionKey) ?? 0;
    if (version >= currentRoomStateVersion) return roomSchema.parse(saved);
    return this.ctx.storage.transactionSync(() => {
      const parsed = migrateRoomStateV0ToV1(saved, {
        readReplay: () => this.ctx.storage.kv.get(replayKey),
        migrateLegacy: (room, original, readReplay) =>
          this.gameAdapter(room).migrateLegacy(room, original, readReplay),
      });
      if (!parsed.success) throw parsed.error;
      this.ctx.storage.kv.put(roomStorageKey, parsed.data);
      this.ctx.storage.kv.put(roomStateVersionKey, currentRoomStateVersion);
      return parsed.data;
    });
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
    if (
      room === null ||
      this.gameAdapter(room).cpu.keepsPlayingWithoutHumans(room) ||
      room.players.some((player) => this.isHumanParticipant(player))
    )
      return room;
    this.closeRoom();
    return null;
  }

  private recordDeparture(player: Room["players"][number]): void {
    if (this.ctx.storage.kv.get(departedKey(player.id))) return;
    this.ctx.storage.kv.delete(analyticsPlayerKey(player.id));
    if (this.readRoom()?.status === "playing")
      this.ctx.storage.kv.put(departedKey(player.id), true);
    appendSystem(this.runtime, "left", `${playerLabel(player)}が退室しました`);
  }

  private releaseResultAvatars(room: Room, retainedIds: Set<string>): void {
    for (const player of room.lastRound?.players ?? []) {
      if (!retainedIds.has(player.id)) this.releaseAccount(player.id, true);
    }
  }

  private closeRoom(): void {
    const room = this.readRoom();
    if (room && "matchmaking" in room && room.matchmaking) {
      const key = `matchmaking:${room.matchmaking.id}`;
      const saved = this.ctx.storage.kv.get<MatchmakingRoomReservation>(key);
      if (saved && saved.phase !== "playing")
        this.ctx.storage.kv.put(key, {
          ...this.clearMatchmakingSearches(saved),
          phase: "closed",
          connectedPlayerIds: room.players
            .filter(
              (p) =>
                p.kind === "human" &&
                hasOpenConnection(this.runtime, this.playerTokenHash(p.id) ?? ""),
            )
            .map((p) => p.id),
        });
    }
    const tournament = tournamentReservation(this.runtime, room);
    if (tournament) {
      const excluded = tournament.excludedPlayerIds ?? [];
      const connectedPlayerIds =
        room?.players
          .filter((player) => {
            const hash = this.playerTokenHash(player.id);
            return (
              !excluded.includes(player.id) &&
              hash !== null &&
              hasOpenConnection(this.runtime, hash)
            );
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
      if (tournament.status !== "closed") recordTournamentState(this.runtime, closed, "aborted");
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
    this.ctx.storage.kv.delete(roomStateVersionKey);
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
    this.ctx.storage.kv.delete(fourReversiAiJobKey);
    this.ctx.storage.kv.delete(fourShogiAiJobKey);
    if (room) this.gameAdapter(room).close();
  }

  private applyProgress(result: ProgressFor<"four-gomoku">): FourGomokuRoom | null;
  private applyProgress(result: ProgressFor<"gomoku">): GomokuRoom | null;
  private applyProgress(result: ProgressFor<"shogi">): ShogiRoom | null;
  private applyProgress(result: ProgressFor<"reversi">): ReversiRoom | null;
  private applyProgress(result: ProgressFor<"four-reversi">): FourReversiRoom | null;
  private applyProgress(result: ProgressFor<"four-shogi">): FourShogiRoom | null;
  private applyProgress(result: ProgressFor<GameId>): Room | null;
  private applyProgress(result: ProgressFor<GameId>): Room | null {
    switch (result.kind) {
      case "rejected":
        throw new Error(`Rejected progress: ${result.error}`);
      case "unchanged":
      case "playing":
        return result.room;
      case "finished": {
        const tournament = tournamentReservation(this.runtime, result.room);
        if (tournament) {
          const closed = { ...tournament, status: "closed" as const };
          this.ctx.storage.kv.put(tournamentReservationKey(tournament.context.matchId), closed);
          recordTournamentState(this.runtime, closed, "saving");
        }
        this.endAnalyticsMatch("completed", result.at, matchEndFacts(result.game));
        return this.gameAdapter(result.room).finish(result, (players, at) =>
          this.rematchPlayers(players, at),
        );
      }
      default:
        return unreachable(result);
    }
  }

  private rematchPlayers<P extends Room["players"]>(seats: P, at: number): P | null {
    const players = seats.filter((player) => {
      if (player.kind === "cpu") return true;
      if (!this.isHumanParticipant(player)) return false;
      const hash = this.playerTokenHash(player.id);
      if (hash === null || this.readMembership(hash) === null) return false;
      if (hasOpenConnection(this.runtime, hash)) return true;
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
        player.kind === "cpu" || hasOpenConnection(this.runtime, this.playerTokenHash(player.id)!)
          ? null
          : this.ctx.storage.kv.get<number>(disconnectedAtKey(player.id))! + reconnectGraceMs,
    })) as P;
  }

  private play(
    tokenHash: string,
    command: ActionCommand,
  ): { status: "placed"; room: Room | null } | { status: RoomSocketError } {
    return this.withIndexTransaction(() => {
      const room = this.readRoom();
      if (!room) return { status: "not_found" };
      const result = this.gameAdapter(room).play(room, tokenHash, command);
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
      const result = this.gameAdapter(room).draw(room, tokenHash, command);
      if (result.kind === "rejected") return { status: result.error };
      if (result.kind === "unchanged") return { status: "unchanged", room: result.room };
      let updated = this.applyProgress(result);
      if (updated) updated = this.applyProgress(this.gameAdapter(updated).afterDraw(updated));
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
      const result = this.gameAdapter(room).declare(room, tokenHash, command);
      if (result.kind === "rejected") return { status: result.error };
      const updated = this.applyProgress(result);
      if (updated) this.ctx.storage.kv.put(roomStorageKey, updated);
      return { status: "updated", room: updated };
    });
  }
  private updateGameSettings(tokenHash: string, command: SettingsCommand) {
    return this.withIndexTransaction(() => {
      const room = this.readRoom();
      if (!room) return { status: "not_found" as const };
      const result = this.gameAdapter(room).settings(room, tokenHash, command);
      if (result.status === "updated") this.ctx.storage.kv.put(roomStorageKey, result.room);
      return result;
    });
  }

  async getFourShogiAnalysisReplay(
    instanceId: string,
    roundId: string,
    positionRevision: number,
    cursor: number,
  ): Promise<
    | { status: "found"; page: import("@tetraboard/protocol").FourShogiAnalysisReplayPage }
    | { status: "not_found" | "room_changed" | "stale_position" }
  > {
    await this.reconcileDeadlines();
    const room = this.readRoom();
    if (!room) return { status: "not_found" };
    if (room.instanceId !== instanceId) return { status: "room_changed" };
    return this.gameAdapter(room).analysisReplay(room, roundId, positionRevision, cursor);
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
    return this.gameAdapter(room).replay(room, roundId, cursor);
  }

  private publicMetadata(room: Room): RoomPublicMetadata & {
    matchKind: MatchKind;
    matchSequence?: number;
    instanceId: string;
    hostPlayerId: string | null;
    participantPreviews: IndexedRoomParticipant[];
  } {
    const host = room.players.find((player) => {
      if (player.kind !== "human" || player.retired) return false;
      const tokenHash = this.playerTokenHash(player.id);
      return tokenHash !== null && this.readMembership(tokenHash)?.role === "host";
    });
    const kind = roomMatchKind(room);
    const matchmaking =
      "matchmaking" in room && room.matchmaking
        ? this.ctx.storage.kv.get<MatchmakingRoomReservation>(`matchmaking:${room.matchmaking.id}`)
        : undefined;
    const matchSequence =
      kind === "tournament"
        ? tournamentReservation(this.runtime, room)?.context.matchSequence
        : kind === "rated" && matchmaking?.instanceId === room.instanceId
          ? matchmaking.matchSequence
          : undefined;
    const humanCount = room.players.filter((player) => player.kind === "human").length;
    return {
      instanceId: room.instanceId,
      matchKind: kind,
      ...(matchSequence === undefined ? {} : { matchSequence }),
      hostPlayerId: host?.id ?? null,
      participantPreviews: room.players.map((player) => ({
        playerId: player.id,
        appearance:
          player.kind === "cpu"
            ? cpuPlayerAppearance(player)
            : {
                kind: "human",
                avatarUrl: player.retired ? null : player.avatarUrl,
                ...(player.retired ? { retired: true as const } : {}),
              },
      })),
      ...roomPublicMetadataSchema.parse({
        id: room.id,
        ...("matchmaking" in room && room.matchmaking ? { matchmaking: true } : {}),
        ...(isTournamentGameRoom(room) && room.tournamentId !== undefined
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

  private async reserveCpuCapacity(
    room: Room,
  ): Promise<RoomCpuCapacity | null | "cpu_capacity_full" | "internal_error"> {
    const game = this.gameAdapter(room).cpu.capacity.game(room);
    if (!game) return null;
    const seats = this.gameAdapter(room).cpu.capacity.seats(room);
    if (!seats) return null;
    await this.cpuCapacityJob.flush();
    if (this.ctx.storage.kv.get(cpuCapacityKey) !== undefined) return "internal_error";
    const sequence = (this.ctx.storage.kv.get<number>(cpuCapacitySequenceKey) ?? 0) + 1;
    const reservation: RoomCpuCapacity = {
      game,
      roomId: room.id,
      sequence,
      instanceId: room.instanceId,
      releaseAtMs: Date.now() + 30_000,
    };
    // RPC中の枠を解放せず、入力ゲートの期限内に確定しなければAlarmで回収します。
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.kv.put(cpuCapacityKey, reservation);
      this.ctx.storage.kv.put(cpuCapacitySequenceKey, sequence);
    });
    try {
      this.alarmEvents.mark();
      await this.alarmEvents.sync();
      if (await this.env.CPU_CAPACITY.getByName(game).reserve(room.id, sequence, seats))
        return { ...reservation, releaseAtMs: null };
      this.ctx.storage.kv.delete(cpuCapacityKey);
      this.alarmEvents.mark();
      return "cpu_capacity_full";
    } catch {
      this.ctx.storage.kv.put(cpuCapacityKey, { ...reservation, releaseAtMs: Date.now() });
      this.alarmEvents.mark();
      this.ctx.waitUntil(this.cpuCapacityJob.flush());
      return "internal_error";
    }
  }

  private readonly cpuCapacityJob = new RoomJob(this.alarmEvents, {
    syncOnlyWhenDue: true,
    pending: () => {
      const job = this.ctx.storage.kv.get<RoomCpuCapacity>(cpuCapacityKey);
      return job ? [job] : [];
    },
    retryAt: (job) => job.releaseAtMs,
    mode: "single",
    execute: (job) => this.env.CPU_CAPACITY.getByName(job.game).release(job.roomId, job.sequence),
    complete: () => {
      this.ctx.storage.kv.delete(cpuCapacityKey);
    },
    retry: (job, releaseAtMs) => this.ctx.storage.kv.put(cpuCapacityKey, { ...job, releaseAtMs }),
  });

  private hasCpuCapacity(room: Room): boolean {
    const reservation = this.ctx.storage.kv.get<RoomCpuCapacity>(cpuCapacityKey);
    return reservation?.instanceId === room.instanceId && reservation.releaseAtMs === null;
  }

  private async recoverPlayingCpuCapacity(): Promise<void> {
    const room = this.readRoom();
    if (
      room?.status !== "playing" ||
      this.hasCpuCapacity(room) ||
      !this.gameAdapter(room).cpu.capacity.game(room) ||
      !this.gameAdapter(room).cpu.currentCpu(room) ||
      !this.gameAdapter(room).cpu.capacity.recoverPlaying(room) ||
      room.clock.turnStartedAt + cpuMoveDelayMs > Date.now() ||
      isClockExpired(room.clock, Date.now())
    )
      return;
    // 既存局・配備前に割当済みの局は、次の外部AI要求前に枠を確保します。
    await this.ctx.blockConcurrencyWhile(async () => {
      const playing = this.readRoom();
      if (playing?.status !== "playing" || this.hasCpuCapacity(playing)) return;
      const reservation = await this.reserveCpuCapacity(playing);
      if (reservation && typeof reservation !== "string")
        this.ctx.storage.kv.put(cpuCapacityKey, reservation);
    });
  }

  private withIndexTransaction<T>(action: () => T, previousRoom?: Room | null): T {
    let changed = false;
    let releaseCpu = false;
    const result = this.usageEvents.run(() =>
      this.ctx.storage.transactionSync(() => {
        const before = previousRoom === undefined ? this.readRoom() : previousRoom;
        const previous = before === null ? null : this.publicMetadata(before);
        const value = action();
        const after = this.readRoom();
        if (
          after?.instanceId !== before?.instanceId ||
          (before?.status === "playing" && after?.status !== "playing")
        ) {
          const reservation = this.ctx.storage.kv.get<RoomCpuCapacity>(cpuCapacityKey);
          if (reservation?.releaseAtMs === null && reservation.instanceId === before?.instanceId) {
            this.ctx.storage.kv.put(cpuCapacityKey, { ...reservation, releaseAtMs: Date.now() });
            releaseCpu = true;
          }
        }
        changed =
          (before === null && after !== null) ||
          (before !== null && after === null) ||
          (before !== null &&
            after !== null &&
            after.publicUpdatedAtMs !== before.publicUpdatedAtMs);
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
      }),
    );
    this.alarmEvents.mark();
    if (changed) this.ctx.waitUntil(this.roomIndexJob.flush());
    if (releaseCpu) this.ctx.waitUntil(this.cpuCapacityJob.flush());
    if ((this.ctx.storage.kv.get<AccountCleanup[]>(accountCleanupKey) ?? []).length)
      this.ctx.waitUntil(this.accountCleanupJob.flush());
    if (this.pendingMatches().size) this.ctx.waitUntil(this.matchJob.flush());
    if (this.pendingShogiMatches().size) this.ctx.waitUntil(this.shogiMatchJob.flush());
    if ([...this.ctx.storage.kv.list({ prefix: pendingTournamentStatePrefix })].length)
      this.ctx.waitUntil(this.tournamentStateJob.flush());
    return result;
  }

  private readonly roomIndexJob = new RoomJob(this.alarmEvents, {
    pending: () => {
      const job = this.ctx.storage.kv.get<PendingRoomIndex>(pendingIndexKey);
      return job ? [job] : [];
    },
    retryAt: (job) => job.retryAtMs,
    execute: (job) => writeRoomIndex(this.env.APP_DB, job),
    complete: (job) => this.updatePendingIndex(job),
    retry: (job, retryAtMs, error) => {
      console.error("Room index update failed", error);
      this.updatePendingIndex(job, retryAtMs);
    },
  });

  private updatePendingIndex(job: PendingRoomIndex, retryAtMs?: number) {
    this.ctx.storage.transactionSync(() => {
      const current = this.ctx.storage.kv.get<PendingRoomIndex>(pendingIndexKey);
      if (current?.revision !== job.revision) return;
      if (retryAtMs !== undefined)
        this.ctx.storage.kv.put(pendingIndexKey, { ...current, retryAtMs });
      else this.ctx.storage.kv.delete(pendingIndexKey);
    });
  }

  private nextAlarmAt(): number | null {
    const room = this.readRoom();
    const cpu = room ? this.gameAdapter(room).cpu : null;
    return nextRoomAlarmAt({
      room,
      registrations: new Map(
        (room?.players ?? []).flatMap((player) => {
          const registration = this.registrationForPlayer(player.id);
          return registration ? [[player.id, registration] as const] : [];
        }),
      ),
      usesIdleDeadline: !!room && !!cpu?.usesIdleDeadline(room),
      cpuAlarmAt:
        room?.status === "playing" && cpu && cpu.currentCpu(room) !== null
          ? cpu.alarmAt(room)
          : null,
      jobs: [
        this.cpuCapacityJob,
        this.roomIndexJob,
        this.accountCleanupJob,
        this.matchJob,
        this.shogiMatchJob,
        this.guestClaimsJob,
        this.tournamentStateJob,
      ].map((job) => job.nextAlarmAt()),
      tournament: tournamentReservation(this.runtime, room),
      matchmaking:
        room && "matchmaking" in room && room.matchmaking
          ? this.ctx.storage.kv.get<MatchmakingRoomReservation>(
              `matchmaking:${room.matchmaking.id}`,
            )
          : undefined,
    });
  }

  private readonly tournamentStateJob = new RoomJob(this.alarmEvents, {
    pending: () =>
      this.ctx.storage.kv.list<PendingTournamentState>({ prefix: pendingTournamentStatePrefix }),
    retryAt: ([, job]) => job.retryAtMs,
    mode: "snapshot",
    stopOnFailure: false,
    execute: ([, job]) => writeTournamentState(this.env.APP_DB, job),
    complete: ([key, job]) => updatePendingTournamentState(this.runtime, key, job),
    retry: ([key, job], retryAtMs) =>
      updatePendingTournamentState(this.runtime, key, job, retryAtMs),
  });

  async prepareTournamentRoom(input: PrepareTournamentRoomInput) {
    return prepareTournamentRoom(this.runtime, input);
  }

  async getTournamentReservationState(matchId: string) {
    return getTournamentReservationState(this.runtime, matchId);
  }

  async abortTournamentRoom(matchId: string, excludedPlayerIds: string[] = []) {
    return abortTournamentRoom(this.runtime, matchId, excludedPlayerIds);
  }

  async rekeyTournamentPlayer(input: RekeyTournamentPlayerInput) {
    return rekeyTournamentPlayer(this.runtime, input);
  }

  async prepareMatchmakingRoom(input: MatchmakingRoomInput) {
    await this.reconcileDeadlines();
    return this.ctx.blockConcurrencyWhile(async () => {
      const rating = input.rating;
      const { game, legacy, rules, policy } = matchmakingRoomConfiguration(input);
      if (
        (input.matchSequence !== undefined &&
          (!Number.isSafeInteger(input.matchSequence) || input.matchSequence < 1 || !rating)) ||
        input.roomId !== this.ctx.id.name ||
        input.players.length < 1 ||
        input.players.length > rules.seats ||
        (rating
          ? !policy?.validParticipants(rating, input.players.length)
          : policy !== undefined) ||
        new Set(input.players.map((p) => p.admission.accountId)).size !== input.players.length ||
        Date.now() >= input.expiresAtMs ||
        input.expiresAtMs !== input.preparedAtMs + rules.connectionGraceMs
      )
        return { status: "invalid" as const };
      const existing = this.ctx.storage.kv.get<MatchmakingRoomReservation>(
        `matchmaking:${input.matchId}`,
      );
      if (existing)
        return existing.phase === "closed"
          ? { status: "cancelled" as const }
          : { status: "prepared" as const };
      if (this.ctx.storage.kv.get(`matchmaking-cancelled:${input.matchId}`))
        return { status: "cancelled" as const };
      if (this.readRoom()) return { status: "room_in_use" as const };
      for (const { admission: a } of input.players) {
        await this.alarmEvents.sync();
        const valid = await this.env.APP_DB.prepare(
          `SELECT 1 FROM account_room_seats s JOIN user u ON u.id=s.account_id JOIN matchmaking_wait_reservations w ON w.account_id=s.account_id WHERE s.account_id=? AND s.operation_id=? AND s.room_id=? AND s.instance_id=? AND s.player_id=? AND w.match_operation_id=s.operation_id AND w.queue_key=? AND u.profileCompleted=1 AND NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE id=u.id)
            ${
              policy
                ? `AND COALESCE(u.isAnonymous,0)=0 AND EXISTS (
              SELECT 1 FROM ${policy.store.pendingTable} p WHERE p.account_id=s.account_id AND p.match_id=?
            )`
                : ""
            }`,
        )
          .bind(
            a.accountId,
            a.operationId,
            input.roomId,
            input.instanceId,
            a.playerId,
            rules.key,
            ...(policy ? [input.matchId] : []),
          )
          .first();
        if (!valid || this.ctx.storage.kv.get(cancelledAdmissionKey(a.operationId)))
          return { status: "invalid" as const };
      }
      const entry = { code: input.roomId, name: input.players[0]!.admission.name };
      const base = waitingRoomFactories[game]({
        ...entry,
        request: { game, mode: "singles", quickPlay: false, timeControl: rules.timeControl },
      });
      const { profile, cpuName } = matchmakingCpuAppearance(game, rating, legacy);
      const seat = this.gameAdapter(base).waitingSeat;
      const cpuCount = rules.seats - input.players.length;
      const room = roomSchema.parse({
        ...base,
        instanceId: input.instanceId,
        matchmaking: matchmakingRoomMetadata(input),
        players: [
          ...input.players.map(({ admission: a }) => ({
            id: a.playerId,
            name: a.name,
            kind: "human",
            avatarUrl: profileAvatarUrl(a.avatarKey, a.avatarPresetId),
            ...(a.isGuest ? { isGuest: true } : {}),
            ready: true,
            ...seat,
            reconnectDeadline: input.expiresAtMs,
          })),
          ...Array.from({ length: cpuCount }, (_, i) => ({
            id: crypto.randomUUID(),
            name: profile
              ? `${profile.name}${i + 1}`
              : cpuCount > 1 && cpuName
                ? `${cpuName}${i + 1}`
                : (cpuName ?? "CPU"),
            kind: "cpu",
            level: 2,
            ...(profile ? { cpuProfile: profile } : {}),
            ready: true,
            ...seat,
            reconnectDeadline: null,
          })),
        ],
      });
      const profileRatings: ProfileRatings = {};
      if (rating && hasProfileRating(game)) {
        for (const { admission } of input.players) {
          profileRatings[admission.playerId] = await readProfileRating(
            this.env.APP_DB,
            admission.accountId,
            game,
            "before",
          );
        }
        const reference = cpuReferenceRating(rating);
        if (reference)
          for (const player of room.players)
            if (player.kind === "cpu") profileRatings[player.id] = reference;
      }
      const capacity = await this.reserveCpuCapacity(room);
      if (typeof capacity === "string") return { status: capacity };
      if (Date.now() >= input.expiresAtMs) {
        if (capacity) {
          this.ctx.storage.kv.put(cpuCapacityKey, { ...capacity, releaseAtMs: Date.now() });
          this.ctx.waitUntil(this.cpuCapacityJob.flush());
        }
        return { status: "invalid" as const };
      }
      this.withIndexTransaction(() => {
        if (capacity) this.ctx.storage.kv.put(cpuCapacityKey, capacity);
        this.ctx.storage.kv.put(roomStorageKey, room);
        this.ctx.storage.kv.put(roomStateVersionKey, currentRoomStateVersion);
        if (rating) this.ctx.storage.kv.put(profileRatingsKey(input.matchId), profileRatings);
        this.ctx.storage.kv.put(`matchmaking:${input.matchId}`, {
          ...input,
          phase: "waiting",
          ...(this.env.AI_WARMUP_ENABLED === "true" && cpuCount > 0 && rating
            ? { aiWarmup: { state: "pending", attempts: 0, nextAtMs: Date.now() } }
            : {}),
        } satisfies MatchmakingRoomReservation);
        for (const [
          index,
          { admission: a, tokenHash, version, search },
        ] of input.players.entries()) {
          this.ctx.storage.kv.put(accountKey(a.playerId), { ...a, occupying: true });
          this.ctx.storage.kv.put(membershipStorageKey(tokenHash), {
            playerId: a.playerId,
            role: index === 0 ? "host" : "player",
          });
          this.ctx.storage.kv.put(playerTokenKey(a.playerId), tokenHash);
          this.ctx.storage.kv.put(`matchmaking-version:${a.playerId}`, version);
          this.ctx.storage.kv.put(disconnectedAtKey(a.playerId), Date.now());
          this.ctx.storage.kv.put(analyticsPlayerKey(a.playerId), {
            accountId: a.accountId,
            visitorId: null,
            isGuest: Boolean(a.isGuest),
            isTest: search?.isTest ?? false,
          });
        }
        for (const p of room.players)
          appendSystem(this.runtime, "joined", `${playerLabel(p)}が入室しました`);
        this.ctx.storage.kv.put(
          viewerSecretKey,
          bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
        );
      });
      return { status: "prepared" as const };
    });
  }
  async getMatchmakingState(matchId: string, instanceId: string) {
    await this.reconcileDeadlines();
    const saved = this.ctx.storage.kv.get<MatchmakingRoomReservation>(`matchmaking:${matchId}`);
    const room = this.readRoom();
    const same = Boolean(
      room &&
      "matchmaking" in room &&
      room.matchmaking?.id === matchId &&
      room.instanceId === instanceId,
    );
    const occupiedPlayerIds = same
      ? room!.players
          .filter((p) => p.kind === "human" && this.storedAccount(p.id)?.occupying)
          .map((p) => p.id)
      : [];
    const connectedPlayerIds = same
      ? room!.players
          .filter(
            (p) =>
              p.kind === "human" &&
              hasOpenConnection(this.runtime, this.playerTokenHash(p.id) ?? ""),
          )
          .map((p) => p.id)
      : (saved?.connectedPlayerIds ?? []);
    let summary: (RoomPublicMetadata & { instanceId: string }) | undefined;
    if (same) {
      const {
        hostPlayerId: _host,
        participantPreviews: _players,
        matchKind: _matchKind,
        ...metadata
      } = this.publicMetadata(room!);
      summary = metadata;
    }
    return {
      phase: same ? (saved?.phase ?? "closed") : "closed",
      started: saved?.phase === "playing",
      aiUnavailable: saved?.aiWarmup?.state === "failed",
      occupiedPlayerIds,
      connectedPlayerIds,
      ...(summary ? { room: summary } : {}),
    };
  }
  async abortMatchmakingRoom(matchId: string, instanceId: string) {
    await this.reconcileDeadlines();
    const reservation = this.ctx.storage.kv.get<MatchmakingRoomReservation>(
      `matchmaking:${matchId}`,
    );
    if (reservation?.phase === "playing") return { status: "already_started" as const };
    const closed = this.withIndexTransaction(() => {
      this.ctx.storage.kv.put(`matchmaking-cancelled:${matchId}`, true);
      const room = this.readRoom();
      if (
        room &&
        "matchmaking" in room &&
        room.matchmaking?.id === matchId &&
        room.instanceId === instanceId
      ) {
        this.closeRoom();
        return true;
      }
      return false;
    });
    if (closed) closeSockets(this.runtime);
    return { status: "aborted" as const };
  }
  async rekeyMatchmakingPlayer(
    matchId: string,
    instanceId: string,
    playerId: string,
    version: number,
    tokenHash: string,
  ) {
    await this.reconcileDeadlines();
    const room = this.readRoom();
    if (
      !room ||
      !("matchmaking" in room) ||
      room.matchmaking?.id !== matchId ||
      room.instanceId !== instanceId ||
      !this.storedAccount(playerId)?.occupying
    )
      return false;
    const current = this.ctx.storage.kv.get<number>(`matchmaking-version:${playerId}`) ?? 0;
    if (version < current) return false;
    const old = this.playerTokenHash(playerId);
    if (version === current) {
      if (old !== tokenHash) return false;
      await this.advanceMatchmakingStart();
      this.alarmEvents.mark();
      return true;
    }
    this.ctx.storage.transactionSync(() => {
      const membership = old ? this.readMembership(old) : null;
      if (old) this.ctx.storage.kv.delete(membershipStorageKey(old));
      this.ctx.storage.kv.put(playerTokenKey(playerId), tokenHash);
      this.ctx.storage.kv.put(membershipStorageKey(tokenHash), {
        playerId,
        role: membership?.role ?? "player",
      });
      this.ctx.storage.kv.put(`matchmaking-version:${playerId}`, version);
      this.ctx.storage.kv.put(disconnectedAtKey(playerId), Date.now());
      const updated = roomSchema.parse({
        ...room,
        players: room.players.map((p) =>
          p.id === playerId
            ? {
                ...p,
                reconnectDeadline:
                  p.reconnectDeadline ??
                  (room.status === "waiting" && !room.lastRound
                    ? room.matchmaking!.preparedAtMs + matchmakingRules.connectionGraceMs
                    : Date.now() + reconnectGraceMs),
              }
            : p,
        ),
      });
      this.ctx.storage.kv.put(roomStorageKey, updated);
    });
    for (const socket of this.ctx.getWebSockets())
      if (
        old &&
        (socket.deserializeAttachment() as { tokenHash?: string } | null)?.tokenHash === old
      )
        socket.close(1000, "操作元が変わりました");
    await this.advanceMatchmakingStart();
    this.alarmEvents.mark();
    return true;
  }
  private startMatchmakingAiWarmup(reservation: MatchmakingRoomReservation) {
    const warmup = reservation.aiWarmup;
    const game = reservation.game ?? this.readRoom()?.settings.game;
    if (warmup?.state !== "pending" || !game || !isRatedMatchmakingGame(game)) return;
    const key = `matchmaking:${reservation.matchId}`;
    const now = Date.now();
    const latest = reservation.expiresAtMs - matchmakingRules.countdownMs;
    if (now >= latest || (warmup.attempts >= aiWarmupMaxAttempts && now >= warmup.nextAtMs)) {
      this.withIndexTransaction(() => {
        this.ctx.storage.kv.put(key, { ...reservation, aiWarmup: { state: "failed" } });
        this.closeRoom();
      });
      console.info({
        event: "rated_ai_warmup_unavailable",
        game,
        matchId: reservation.matchId,
        atMs: now,
      });
      return;
    }
    if (now < warmup.nextAtMs) return;
    const attempt = warmup.attempts + 1;
    const deadline = Math.min(now + aiWarmupAttemptMs, latest);
    // 保存済みの期限で重複送信を防ぎ、処理が中断してもAlarmで再開します。
    this.ctx.storage.kv.put(key, {
      ...reservation,
      aiWarmup: { state: "pending", attempts: attempt, nextAtMs: deadline + aiWarmupRetryMs },
    } satisfies MatchmakingRoomReservation);
    console.info({
      event: "rated_ai_warmup_started",
      game,
      matchId: reservation.matchId,
      attempt,
      atMs: now,
    });
    this.alarmEvents.mark();
    this.ctx.waitUntil(this.finishMatchmakingAiWarmup(key, game, attempt, deadline));
  }

  private async finishMatchmakingAiWarmup(
    key: string,
    game: RatedAiGame,
    attempt: number,
    deadline: number,
  ) {
    await this.alarmEvents.sync();
    const failure = await requestRatedAiWarmup(this.env, game, deadline);
    const saved = this.ctx.storage.kv.get<MatchmakingRoomReservation>(key);
    const room = this.readRoom();
    if (
      !saved ||
      saved.phase !== "waiting" ||
      saved.aiWarmup?.state !== "pending" ||
      saved.aiWarmup.attempts !== attempt ||
      room?.instanceId !== saved.instanceId
    )
      return;
    const now = Date.now();
    const reason = now >= deadline ? "timeout" : failure;
    this.ctx.storage.kv.put(key, {
      ...saved,
      aiWarmup: reason
        ? {
            state: "pending",
            attempts: attempt,
            nextAtMs: attempt < aiWarmupMaxAttempts ? now + aiWarmupRetryMs : now,
          }
        : { state: "ready" },
    } satisfies MatchmakingRoomReservation);
    console.info({
      event: reason ? "rated_ai_warmup_failed" : "rated_ai_warmup_ready",
      game,
      matchId: saved.matchId,
      attempt,
      atMs: now,
      ...(reason ? { reason } : {}),
    });
    this.alarmEvents.mark();
    await this.advanceMatchmakingStart();
    await this.alarmEvents.sync();
  }

  private async advanceMatchmakingStart() {
    const current = this.readRoom();
    if (
      !current ||
      !("matchmaking" in current) ||
      !current.matchmaking ||
      current.status !== "waiting" ||
      current.lastRound
    )
      return;
    let reservation = this.ctx.storage.kv.get<MatchmakingRoomReservation>(
      `matchmaking:${current.matchmaking.id}`,
    );
    if (!reservation || reservation.phase !== "waiting") return;
    if (reservation.aiWarmup) {
      const connected = current.players
        .filter((p) => p.kind === "human")
        .every((p) => hasOpenConnection(this.runtime, this.playerTokenHash(p.id) ?? ""));
      if (connected !== Boolean(reservation.aiHumansConnected)) {
        reservation = { ...reservation, aiHumansConnected: connected };
        this.ctx.storage.kv.put(`matchmaking:${reservation.matchId}`, reservation);
        if (connected)
          console.info({
            event: "rated_ai_all_connected",
            game: current.settings.game,
            matchId: reservation.matchId,
            atMs: Date.now(),
          });
      }
      if (reservation.aiWarmup?.state === "pending") {
        this.startMatchmakingAiWarmup(reservation);
        this.alarmEvents.mark();
        if (!this.readRoom()) closeSockets(this.runtime);
        return;
      }
    }
    const readyReservation = reservation;
    const diagnostic = this.withIndexTransaction(() => {
      const room = this.readRoom();
      if (
        !room ||
        !("matchmaking" in room) ||
        !room.matchmaking ||
        room.status !== "waiting" ||
        room.lastRound
      )
        return;
      if (
        Date.now() >= readyReservation.expiresAtMs ||
        room.players.length !== gameCapacity(room.settings.game)
      ) {
        this.closeRoom();
        return;
      }
      const connected = room.players
        .filter((p) => p.kind === "human")
        .every((p) => hasOpenConnection(this.runtime, this.playerTokenHash(p.id) ?? ""));
      if (!connected) {
        if (room.matchmaking.startsAtMs !== undefined) {
          const { startsAtMs: _deadline, ...metadata } = room.matchmaking;
          this.ctx.storage.kv.put(roomStorageKey, {
            ...room,
            matchmaking: metadata,
            publicUpdatedAtMs: nextPublicUpdateAt(room),
          });
          return { event: "four_shogi_countdown_reset", atMs: Date.now() };
        }
        return;
      }
      const deadline = room.matchmaking.startsAtMs;
      if (deadline === undefined) {
        const atMs = Date.now();
        this.ctx.storage.kv.put(roomStorageKey, {
          ...room,
          matchmaking: {
            ...room.matchmaking,
            startsAtMs: atMs + matchmakingRules.countdownMs,
          },
          publicUpdatedAtMs: nextPublicUpdateAt(room),
        });
        return { event: "four_shogi_connected", atMs };
      }
      if (Date.now() < deadline) return;
      const started = this.gameAdapter(room).start(room, {
        kind: "matchmaking",
        rating: readyReservation.rating,
      });
      this.ctx.storage.kv.put(`matchmaking:${room.matchmaking.id}`, {
        ...readyReservation,
        phase: "playing",
      } satisfies MatchmakingRoomReservation);
      this.startAnalyticsMatch(started.roundId, started.room, started.at);
      return { event: "four_shogi_started", atMs: started.at };
    });
    if (diagnostic)
      this.gameAdapter(current).matchmakingDiagnostic(
        readyReservation.rating,
        readyReservation.matchId,
        diagnostic.event,
        diagnostic.atMs,
      );
    const room = this.readRoom();
    this.alarmEvents.mark();
    if (room) broadcastRoom(this.runtime, room);
    else closeSockets(this.runtime);
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
            initialRoom.players[0].avatarUrl !==
              profileAvatarUrl(admission.avatarKey, admission.avatarPresetId)
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
        this.ctx.storage.kv.put(roomStateVersionKey, currentRoomStateVersion);
        this.ctx.storage.kv.put(
          membershipStorageKey(tokenHash),
          roomMembershipSchema.parse({ playerId: initialRoom.players[0].id, role: "host" }),
        );
        this.ctx.storage.kv.put(playerTokenKey(initialRoom.players[0].id), tokenHash);
        this.ctx.storage.kv.put(disconnectedAtKey(initialRoom.players[0].id), Date.now());
        for (const player of initialRoom.players) {
          appendSystem(this.runtime, "joined", `${playerLabel(player)}が入室しました`);
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
    return created;
  }

  async getRoom(): Promise<Room | null> {
    await this.reconcileDeadlines();
    return this.readRoom();
  }

  async getShareMetadata(instanceId: string) {
    // ルームの進行や期限処理を呼ばず、クローラーの取得で対局・時計・保存を変更しません。
    const saved = this.ctx.storage.kv.get(roomStorageKey);
    const version = this.ctx.storage.kv.get<number>(roomStateVersionKey) ?? 0;
    const parsed =
      version >= currentRoomStateVersion
        ? roomSchema.safeParse(saved)
        : migrateRoomStateV0ToV1(saved, {
            readReplay: () => this.ctx.storage.kv.get(replayKey),
            migrateLegacy: (room, original, readReplay) =>
              this.gameAdapter(room).migrateLegacy(room, original, readReplay),
          });
    if (!parsed.success) return null;
    const room = parsed.data;
    const now = Date.now();
    if (room.instanceId !== instanceId || room.lastActivityAtMs + idleMs <= now) return null;
    const retained = room.players.some((player) => {
      if (!this.isHumanParticipant(player)) return false;
      if ((this.registrationForPlayer(player.id)?.holdUntilMs ?? 0) > now) return true;
      const hash = this.playerTokenHash(player.id);
      if (hash && hasOpenConnection(this.runtime, hash)) return true;
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
          presence: presence(this.runtime, room),
          serverNowMs: Date.now(),
          ...roomFormationAnalysis(room, formationAnalysis),
          ...this.gameAdapter(room).displayHands(room, eliminatedHands),
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
    const matchmaking = "matchmaking" in room ? room.matchmaking : undefined;
    const rated =
      matchmaking &&
      this.ctx.storage.kv.get<MatchmakingRoomReservation>(`matchmaking:${matchmaking.id}`)?.rating;
    return {
      status: "found" as const,
      game: room.settings.game,
      player,
      accountId: this.storedAccount(playerId)?.accountId ?? null,
      ...(matchmaking && rated && hasProfileRating(room.settings.game)
        ? {
            profileRating:
              this.ctx.storage.kv.get<ProfileRatings>(profileRatingsKey(matchmaking.id))?.[
                playerId
              ] ??
              (player.kind === "human"
                ? { timing: "before" as const, status: "unavailable" as const }
                : undefined),
          }
        : {}),
    };
  }

  async refreshLobbyIndex(expectedInstanceId: string | null, expectedRevision: number) {
    await this.reconcileDeadlines();
    const room = this.readRoom();
    if (room === null) {
      // 番号が再利用された後の行や、新しいrevisionは閉じません。
      await this.alarmEvents.sync();
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
    this.alarmEvents.mark();
    await this.roomIndexJob.flush();
  }

  async getPublicMetadata(profilePreview = false) {
    await this.reconcileDeadlines();
    const room = this.readRoom();
    if (room === null) return null;
    const {
      instanceId,
      hostPlayerId,
      participantPreviews: _previews,
      matchKind: _matchKind,
      matchSequence: _matchSequence,
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
    return this.currentRoomMembership(tokenHash);
  }

  /** 期限を確認した入口から、awaitを挟まず現在の資格を照合します。 */
  private currentRoomMembership(
    tokenHash: string,
  ):
    | { status: "found"; membership: RoomMembership }
    | { status: "not_found" }
    | { status: "unauthorized" } {
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
    | { status: "matchmaking_required" }
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
        if ("matchmaking" in room && room.matchmaking)
          return { status: "matchmaking_required" } as const;
        if (isTournamentGameRoom(room) && room.tournamentId !== undefined)
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
              avatarUrl: admission
                ? profileAvatarUrl(admission.avatarKey, admission.avatarPresetId)
                : null,
              ...(admission?.isGuest ? { isGuest: true } : {}),
              ready: false,
              ...this.gameAdapter(room).waitingSeat,
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
        appendSystem(this.runtime, "joined", `${playerName}が入室しました`);
        return { status: "joined", room: updatedRoom, membership } as const;
      }),
    );

    if (result === null) return { status: "account_reservation_invalid" };
    if (result.status === "joined") {
      broadcastRoom(this.runtime, result.room);
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

  private async reconcileDeadlines(applyCpu = false): Promise<void> {
    const code = this.ctx.id.name ?? this.readRoom()?.id;
    if (code) {
      await this.alarmEvents.sync();
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
    if (applyCpu) {
      await this.cpuCapacityJob.flush();
      await this.recoverPlayingCpuCapacity();
    }
    const initial = this.readRoom();
    const now = Date.now();
    const promoted: string[] = [];
    let changed = false;
    const cpuWork: { current: ExternalCpuRequest | null; afterTransaction?: () => void } = {
      current: null,
    };
    const updated = this.withIndexTransaction(() => {
      // 将棋の読取りは従来どおりtransaction内。リバーシは最初の読取りを使用。
      let room: Room | null =
        initial && this.gameAdapter(initial).cpu.reloadBeforeDeadlines ? this.readRoom() : initial;
      if (!room) return null;
      const tournament = tournamentReservation(this.runtime, room);
      if (
        tournament?.status === "waiting" &&
        isTournamentGameRoom(room) &&
        room.status === "waiting" &&
        room.tournamentStartsAtMs !== undefined &&
        !tournamentPlayersConnected(this.runtime, room)
      ) {
        const { tournamentStartsAtMs: _deadline, ...waiting } = room;
        room = roomSchema.parse({
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
      const idle =
        this.gameAdapter(room).cpu.usesIdleDeadline(room) && room.lastActivityAtMs + idleMs <= now;
      if (idle || this.closeIfNoHumanParticipants(room) === null) {
        if (idle) this.closeRoom();
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
          hasOpenConnection(this.runtime, hash)
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
          room = this.applyProgress(this.gameAdapter(room).cpu.timeout(room, deadline.at));
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
            room = this.applyProgress(
              this.gameAdapter(room).cpu.disconnect(room, player.id, deadline.at),
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
        if (applyCpu) {
          const result = this.gameAdapter(room).cpu.step(room, {
            now,
            hasCapacity: (current) => this.hasCpuCapacity(current),
            applyProgress: (progress) => {
              const current = this.applyProgress(progress);
              if (current) this.ctx.storage.kv.put(roomStorageKey, current);
              changed = true;
              return current;
            },
          });
          room = result.room;
          cpuWork.current = result.external ?? null;
          cpuWork.afterTransaction = result.afterTransaction;
        }
      }
      return room;
    }, initial);
    cpuWork.afterTransaction?.();
    this.ctx.waitUntil(this.roomIndexJob.flush());
    this.ctx.waitUntil(this.accountCleanupJob.flush());
    this.ctx.waitUntil(this.tournamentStateJob.flush());
    if (!initial || this.gameAdapter(initial).cpu.waitUntilMatchFlush)
      this.ctx.waitUntil(this.matchJob.flush());
    this.ctx.waitUntil(this.guestClaimsJob.flush());
    if (changed) {
      if (updated) broadcastRoom(this.runtime, updated);
      else closeSockets(this.runtime);
    }
    for (const hash of promoted) sendCurrentMembership(this.runtime, hash);
    await advanceTournamentStart(this.runtime);
    await this.advanceMatchmakingStart();
    if (cpuWork.current) {
      // transactionとDOの入力ゲートを保持せず、ネットワーク応答を待ちます。
      await this.alarmEvents.sync();
      const response = await cpuWork.current.request();
      await this.reconcileDeadlines();
      this.ctx.storage.transactionSync(() => {
        response.apply(this.readRoom(), Date.now());
      });
      response.afterTransaction?.();
      this.alarmEvents.mark();
    }
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
        const tournament = tournamentReservation(this.runtime, room);
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
      } else {
        this.recordDeparture(player);
        this.releaseAccount(player.id, false);
        const adapter = this.gameAdapter(room);
        const leave = adapter.prepareLeave(room, player.id);
        this.ctx.storage.kv.delete(membershipStorageKey(tokenHash));
        this.ctx.storage.kv.delete(playerTokenKey(player.id));
        const at = Date.now();
        updated = this.applyProgress(leave(at, membership.role === "host"));
        if (updated) {
          updated = adapter.afterLeave(updated, room, at, membership.role === "host");
          this.ctx.storage.kv.put(roomStorageKey, updated);
        }
      }
      updated = this.closeIfNoHumanParticipants(updated);
      return { status: "left" as const, room: updated };
    });
    if (result.status === "time_expired") {
      await this.reconcileDeadlines();
      return this.leaveRoom(tokenHash);
    }
    if (result.status !== "left") return result.status;
    if (result.room === null) closeSockets(this.runtime);
    else broadcastRoom(this.runtime, result.room);
    if (promoted !== null) sendCurrentMembership(this.runtime, promoted);
    closeSockets(this.runtime, tokenHash);
    return "left";
  }

  async issueViewerToken(): Promise<string | null> {
    return issueViewerToken(this.runtime);
  }

  async inspectReport(token: string, messageId: string): ReturnType<typeof inspectReport> {
    return inspectReport(this.runtime, token, messageId);
  }

  async moderateMessage(
    instanceId: string,
    messageId: string,
    senderId: string,
    remove: boolean,
    mute: boolean,
  ): Promise<"applied" | "room_changed"> {
    return moderateMessage(this.runtime, instanceId, messageId, senderId, remove, mute);
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
        appendSystem(
          this.runtime,
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
          appendSystem(this.runtime, "joined", `CPU Lv${player.level}が入室しました`);
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

  private async startGame(tokenHash: string): Promise<
    | { status: "started"; room: Room }
    | {
        status:
          | "not_found"
          | "unauthorized"
          | "forbidden"
          | "not_ready"
          | "already_started"
          | "registration_pending"
          | "cpu_capacity_full"
          | "internal_error";
      }
  > {
    return this.ctx.blockConcurrencyWhile(async () => {
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
          return !player.ready || hash === null || !hasOpenConnection(this.runtime, hash);
        })
      ) {
        return { status: "not_ready" };
      }

      const capacity = await this.reserveCpuCapacity(room);
      if (typeof capacity === "string") return { status: capacity };
      return this.withIndexTransaction(() => {
        if (capacity) this.ctx.storage.kv.put(cpuCapacityKey, capacity);
        const started = this.gameAdapter(room).start(room, { kind: "normal" });
        this.releaseResultAvatars(room, new Set(started.room.players.map((player) => player.id)));
        this.startAnalyticsMatch(started.roundId, started.room, started.at);
        return { status: "started", room: started.room };
      });
    });
  }

  private resign(
    tokenHash: string,
  ): { status: "resigned"; room: Room | null } | { status: RoomSocketError } {
    return this.withIndexTransaction(() => {
      const room = this.readRoom();
      if (!room) return { status: "not_found" };
      const result = this.gameAdapter(room).resign(room, tokenHash);
      if (result.kind === "rejected") return { status: result.error };
      const updated = this.applyProgress(result);
      if (updated) this.ctx.storage.kv.put(roomStorageKey, updated);
      return { status: "resigned", room: updated };
    });
  }

  async fetch(request: Request): Promise<Response> {
    return fetch(this.runtime, request);
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    return webSocketMessage(this.runtime, socket, message);
  }

  async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    return webSocketClose(this.runtime, socket, code, reason);
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    return webSocketError(this.runtime, socket);
  }
}

wrapRoomAlarmEvents(GameRoom);
