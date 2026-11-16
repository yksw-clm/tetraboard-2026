import * as roomUseCases from "@tetraboard/context-room";
import type { GameId, ProfileRatings } from "@tetraboard/protocol";
import {
  joinRoomContract,
  roomSchema,
  tournamentRules,
  type Room,
  type RoomMembership,
} from "@tetraboard/protocol";
import { DurableObject } from "cloudflare:workers";
import { hasProfileRating, profileRatingsKey } from "../../accounts/profileRatings";
import { type AccountAdmission } from "../../accounts/roomAccounts";
import { nextAlarmAt } from "../../adapters/room/alarm";
import {
  applyProgress,
  closeIfNoHumanParticipants,
  removeWaitingPlayer,
} from "../../adapters/room/commands";
import { hasCpuCapacity, recoverPlayingCpuCapacity } from "../../adapters/room/cpuCapacity";
import { TransactionRoomEffects, executeRoomEffect } from "../../adapters/room/effects";
import { refreshLobbyIndex } from "../../adapters/room/indexJob";
import { createRoomJobs } from "../../adapters/room/jobs";
import { publicMetadata } from "../../adapters/room/metadata";
import {
  currentRoomMembership,
  isHumanParticipant,
  playerTokenHash,
  purgeLegacyAnalytics,
  readMembership,
  readRoom,
} from "../../adapters/room/state";
import { withIndexTransaction } from "../../adapters/room/transaction";
import {
  appendRoomSystem,
  closeRoom,
  invokeRoomUseCase,
  recordDeparture,
  roomAdmission,
} from "../../adapters/room/useCases";
import { purgeAccount } from "../../flows/accountPurge/purge";
import { withAccountAdmission } from "../../flows/accountSeats/admission";
import {
  accountReservationState,
  cancelAccountReservation,
} from "../../flows/accountSeats/reservations";
import { releaseAccount, storedAccount } from "../../flows/accountSeats/seats";
import { beginGuestRegistration } from "../../flows/guestRegistration/begin";
import { armGuestMatchClaims, guestMergeConflict } from "../../flows/guestRegistration/claims";
import { completeGuestRegistration } from "../../flows/guestRegistration/complete";
import {
  cancelGuestRegistration,
  endRegistration,
  getGuestRegistration,
  registrationForPlayer,
  validateGuestRegistrationAccount,
} from "../../flows/guestRegistration/records";
import { prepareMatchmakingRoom } from "../../flows/matchmakingRoom/prepare";
import { rekeyMatchmakingPlayer } from "../../flows/matchmakingRoom/rekey";
import {
  abortMatchmakingRoom,
  getMatchmakingState,
} from "../../flows/matchmakingRoom/reservations";
import { advanceMatchmakingStart } from "../../flows/matchmakingRoom/start";
import { prepareTournamentRoom } from "../../flows/tournamentRoom/prepare";
import { rekeyTournamentPlayer } from "../../flows/tournamentRoom/rekey";
import {
  abortTournamentRoom,
  getTournamentReservationState,
  tournamentReservation,
} from "../../flows/tournamentRoom/reservations";
import {
  advanceTournamentStart,
  tournamentPlayersConnected,
} from "../../flows/tournamentRoom/start";
import { logFourShogiDiagnostic } from "../../fourShogiDiagnostics";
import type {
  MatchmakingRoomInput,
  MatchmakingRoomReservation,
} from "../../matchmaking/coordinator";
import { isClockExpired } from "../../rooms/clock";
import { roomFormationAnalysis } from "../../rooms/fourShogiFormationAnalysis";
import { createGameAdapters } from "../../rooms/gameAdapters";
import type { ExternalCpuRequest } from "../../rooms/gameAdapters/cpuTypes";
import type { GameAdapter } from "../../rooms/gameAdapters/types";
import { unreachable } from "../../rooms/gameProgress";
import {
  cpuMoveDelayMs,
  nextPublicUpdateAt,
  replayKey,
  roomStorageKey,
} from "../../rooms/progressHelpers";
import {
  type BeginGuestRegistrationResult,
  type CompleteGuestRegistrationResult,
  type GuestRegistrationInput,
  type GuestRegistrationState,
} from "../../rooms/registrationTypes";
import { RoomAlarmEvents, wrapRoomAlarmEvents } from "../../rooms/roomAlarmEvents";
import { nextDueRoomDeadline } from "../../rooms/roomDeadlines";
import {
  currentRoomStateVersion,
  migrateRoomStateV0ToV1,
  roomStateVersionKey,
} from "../../rooms/roomStateVersion";
import {
  isTournamentGameRoom,
  type PrepareTournamentRoomInput,
  type RekeyTournamentPlayerInput,
} from "../../rooms/tournamentRoom";
import { type AnalyticsIdentity } from "../../usageEvents/matches";
import { TransactionUsageEvents } from "../../usageEvents/transactionEvents";
import { closeSockets, webSocketClose, webSocketError } from "./connections";
import { fetch } from "./fetch";
import { inspectReport, moderateMessage } from "./reports";
import type { RoomRuntime } from "./runtime";
import { broadcastRoom, presence } from "./snapshots";
import { hasOpenConnection, sendCurrentMembership } from "./socket/membership";
import { webSocketMessage } from "./socket/message";
import { disconnectedAtKey, reconnectGraceMs } from "./storageKeys";
import { issueViewerToken } from "./viewerTokens";

const idleMs = 24 * 60 * 60 * 1000;
export class GameRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      purgeLegacyAnalytics(this.runtime);
    });
  }

  private readonly alarmEvents = new RoomAlarmEvents(
    this,
    this.ctx.storage,
    () => nextAlarmAt(this.runtime),
    (task) => this.ctx.waitUntil(task),
  );
  private readonly effects = new TransactionRoomEffects((effect) =>
    executeRoomEffect(this.runtime, effect),
  );
  private readonly chat = { dirty: false };
  private readonly usageEvents = new TransactionUsageEvents(() => this.env.USAGE_EVENTS);
  private readonly progressDependencies = {
    storage: this.ctx.storage,
    membership: (hash: string) => readMembership(this.runtime, hash),
    accountId: (playerId: string) => storedAccount(this.runtime, playerId)?.accountId ?? null,
  };
  private readonly adapters = createGameAdapters({
    ...this.progressDependencies,
    aiService: () => this.env,
    appendSystem: (event, text) => appendRoomSystem(this.runtime, event, text),
    recordDeparture: (player) => recordDeparture(this.runtime, player),
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

  private readonly runtime: RoomRuntime = this.createRuntime();

  private createRuntime(): RoomRuntime {
    const getJobs = () => this.jobs;
    const getEnv = () => this.env;
    return {
      ctx: this.ctx,
      alarms: this.alarmEvents,
      get cpuCapacity() {
        return getEnv().CPU_CAPACITY;
      },
      get accountBindings() {
        return getEnv();
      },
      usageEvents: this.usageEvents,
      get jobs() {
        return getJobs();
      },
      get db() {
        return getEnv().APP_DB;
      },
      aiService: () => this.env,
      effects: this.effects,
      chat: this.chat,
      reconcileDeadlines: (applyCpu) => this.reconcileDeadlines(applyCpu),
      gameAdapter: (room) => this.gameAdapter(room),
    };
  }

  private readonly jobs = createRoomJobs(this.runtime);

  async guestMergeConflict(guestId: string, accountId: string): Promise<boolean> {
    return guestMergeConflict(this.runtime, guestId, accountId);
  }

  async purgeAccount(accountId: string) {
    return purgeAccount(this.runtime, accountId);
  }

  async getGuestRegistration(registrationId: string): Promise<GuestRegistrationState | null> {
    return getGuestRegistration(this.runtime, registrationId);
  }

  async validateGuestRegistrationAccount(
    registrationId: string,
    accountId: string,
  ): Promise<"eligible" | "conflict" | "not_found" | "cancelled" | "expired"> {
    return validateGuestRegistrationAccount(this.runtime, registrationId, accountId);
  }

  async armGuestMatchClaims(): Promise<void> {
    return armGuestMatchClaims(this.runtime);
  }

  async beginGuestRegistration(
    input: GuestRegistrationInput,
  ): Promise<BeginGuestRegistrationResult> {
    return beginGuestRegistration(this.runtime, input);
  }

  async cancelGuestRegistration(registrationId: string): Promise<GuestRegistrationState | null> {
    return cancelGuestRegistration(this.runtime, registrationId);
  }

  async completeGuestRegistration(
    registrationId: string,
    admission: AccountAdmission,
    analytics?: AnalyticsIdentity,
  ): Promise<CompleteGuestRegistrationResult> {
    return completeGuestRegistration(this.runtime, registrationId, admission, analytics);
  }

  async accountReservationState(
    admission: AccountAdmission,
  ): Promise<"occupied" | "released" | "pending"> {
    return accountReservationState(this.runtime, admission);
  }

  async cancelAccountReservation(admission: AccountAdmission) {
    return cancelAccountReservation(this.runtime, admission);
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
    const room = readRoom(this.runtime);
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
    const room = readRoom(this.runtime);
    if (!room) return { status: "not_found" };
    if (room.instanceId !== instanceId) return { status: "room_changed" };
    return this.gameAdapter(room).replay(room, roundId, cursor);
  }

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
    return prepareMatchmakingRoom(this.runtime, input);
  }

  async getMatchmakingState(matchId: string, instanceId: string) {
    return getMatchmakingState(this.runtime, matchId, instanceId);
  }

  async abortMatchmakingRoom(matchId: string, instanceId: string) {
    return abortMatchmakingRoom(this.runtime, matchId, instanceId);
  }

  async rekeyMatchmakingPlayer(
    matchId: string,
    instanceId: string,
    playerId: string,
    version: number,
    tokenHash: string,
  ) {
    return rekeyMatchmakingPlayer(this.runtime, matchId, instanceId, playerId, version, tokenHash);
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

    return withAccountAdmission(this.runtime, admission, () =>
      withIndexTransaction(this.runtime, () => {
        const secret = new Uint8Array(32);
        crypto.getRandomValues(secret);
        return invokeRoomUseCase(
          this.runtime,
          (op) =>
            roomUseCases.createRoom(
              op,
              initialRoom,
              tokenHash,
              Array.from(secret, (byte) => byte.toString(16).padStart(2, "0")).join(""),
              roomAdmission(admission),
            ),
          { admission, analytics },
        );
      }),
    );
  }

  async getRoom(): Promise<Room | null> {
    await this.reconcileDeadlines();
    return readRoom(this.runtime);
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
      if (!isHumanParticipant(this.runtime, player)) return false;
      if ((registrationForPlayer(this.runtime, player.id)?.holdUntilMs ?? 0) > now) return true;
      const hash = playerTokenHash(this.runtime, player.id);
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
      accountId: storedAccount(this.runtime, playerId)?.accountId ?? null,
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
    return refreshLobbyIndex(this.runtime, expectedInstanceId, expectedRevision);
  }

  async getPublicMetadata(profilePreview = false) {
    await this.reconcileDeadlines();
    const room = readRoom(this.runtime);
    if (room === null) return null;
    const {
      instanceId,
      hostPlayerId,
      participantPreviews: _previews,
      matchKind: _matchKind,
      matchSequence: _matchSequence,
      ...metadata
    } = publicMetadata(this.runtime, room);
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
    return currentRoomMembership(this.runtime, tokenHash);
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
    const result = await withAccountAdmission(this.runtime, admission, () =>
      withIndexTransaction(this.runtime, () =>
        invokeRoomUseCase(
          this.runtime,
          (op) =>
            roomUseCases.joinRoom(
              op,
              playerName,
              tokenHash,
              admission?.playerId ?? crypto.randomUUID(),
              instanceId,
              roomAdmission(admission),
            ),
          { admission, analytics },
        ),
      ),
    );
    return result ?? { status: "account_reservation_invalid" };
  }

  private async reconcileDeadlines(applyCpu = false): Promise<void> {
    const code = this.ctx.id.name ?? readRoom(this.runtime)?.id;
    if (code) {
      await this.alarmEvents.sync();
      const pending = await this.env.APP_DB.prepare(
        "SELECT account_id FROM deletion_rooms WHERE room_id=?",
      )
        .bind(code)
        .all<{ account_id: string }>();
      for (const row of pending.results) {
        await purgeAccount(this.runtime, row.account_id);
        await this.env.APP_DB.prepare("DELETE FROM deletion_rooms WHERE room_id=? AND account_id=?")
          .bind(code, row.account_id)
          .run();
      }
    }
    if (applyCpu) {
      await this.jobs.cpuCapacityJob.flush();
      await recoverPlayingCpuCapacity(this.runtime);
    }
    const initial = readRoom(this.runtime);
    const now = Date.now();
    const promoted: string[] = [];
    let changed = false;
    const cpuWork: { current: ExternalCpuRequest | null; afterTransaction?: () => void } = {
      current: null,
    };
    const updated = withIndexTransaction(
      this.runtime,
      () => {
        // 将棋の読取りは従来どおりtransaction内。リバーシは最初の読取りを使用。
        let room: Room | null =
          initial && this.gameAdapter(initial).cpu.reloadBeforeDeadlines
            ? readRoom(this.runtime)
            : initial;
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
          closeRoom(this.runtime);
          changed = true;
          return null;
        }
        const idle =
          this.gameAdapter(room).cpu.usesIdleDeadline(room) &&
          room.lastActivityAtMs + idleMs <= now;
        if (idle || closeIfNoHumanParticipants(this.runtime, room) === null) {
          if (idle) closeRoom(this.runtime);
          changed = true;
          return null;
        }
        const registrationPlayers = room.players.map((player) => {
          if (player.kind !== "human") return player;
          let registration = registrationForPlayer(this.runtime, player.id);
          if (registration && registration.holdUntilMs <= now) {
            endRegistration(this.runtime, registration, "expired");
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
          const hash = playerTokenHash(this.runtime, player.id);
          if (
            !isHumanParticipant(this.runtime, player) ||
            player.reconnectDeadline !== null ||
            hash === null ||
            hasOpenConnection(this.runtime, hash)
          )
            return player;
          const disconnectedAt =
            this.ctx.storage.kv.get<number>(disconnectedAtKey(player.id)) ?? now;
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
            room = applyProgress(
              this.runtime,
              this.gameAdapter(room).cpu.timeout(room, deadline.at),
            );
          } else if (deadline.type === "disconnect") {
            const player: Room["players"][number] | undefined = room.players.find(
              (p) => p.id === deadline.playerId,
            );
            if (!player) throw new Error("Deadline player is missing");
            if (room.status === "waiting") {
              const wasHost = room.players[0].id === player.id;
              room = removeWaitingPlayer(this.runtime, room, player.id);
              if (wasHost && room) {
                const hash = playerTokenHash(this.runtime, room.players[0].id);
                if (hash) promoted.push(hash);
              }
            } else {
              recordDeparture(this.runtime, player);
              releaseAccount(this.runtime, player.id, false);
              room = applyProgress(
                this.runtime,
                this.gameAdapter(room).cpu.disconnect(room, player.id, deadline.at),
              );
            }
          }
          room = closeIfNoHumanParticipants(this.runtime, room);
          changed = true;
          if (room) this.ctx.storage.kv.put(roomStorageKey, room);
        }
        const retained = closeIfNoHumanParticipants(this.runtime, room);
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
              hasCapacity: (current) => hasCpuCapacity(this.runtime, current),
              applyProgress: (progress) => {
                const current = applyProgress(this.runtime, progress);
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
      },
      initial,
    );
    cpuWork.afterTransaction?.();
    this.ctx.waitUntil(this.jobs.roomIndexJob.flush());
    this.ctx.waitUntil(this.jobs.accountCleanupJob.flush());
    this.ctx.waitUntil(this.jobs.tournamentStateJob.flush());
    if (!initial || this.gameAdapter(initial).cpu.waitUntilMatchFlush)
      this.ctx.waitUntil(this.jobs.matchJob.flush());
    this.ctx.waitUntil(this.jobs.guestClaimsJob.flush());
    if (changed) {
      if (updated) broadcastRoom(this.runtime, updated);
      else closeSockets(this.runtime);
    }
    for (const hash of promoted) sendCurrentMembership(this.runtime, hash);
    await advanceTournamentStart(this.runtime);
    await advanceMatchmakingStart(this.runtime);
    if (cpuWork.current) {
      // transactionとDOの入力ゲートを保持せず、ネットワーク応答を待ちます。
      await this.alarmEvents.sync();
      const response = await cpuWork.current.request();
      await this.reconcileDeadlines();
      this.ctx.storage.transactionSync(() => {
        response.apply(readRoom(this.runtime), Date.now());
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
    const result = withIndexTransaction(this.runtime, () =>
      invokeRoomUseCase(this.runtime, (op) => roomUseCases.leaveRoom(op, tokenHash)),
    );
    if (result.status === "time_expired") {
      await this.reconcileDeadlines();
      return this.leaveRoom(tokenHash);
    }
    return result.status;
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
