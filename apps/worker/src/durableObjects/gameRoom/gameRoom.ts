import type {
  FourGomokuRoom,
  GameId,
  GomokuRoom,
  ProfileRatings,
  ReversiRoom,
  ShogiRoom,
} from "@tetraboard/protocol";
import {
  joinRoomContract,
  roomMembershipSchema,
  roomSchema,
  tournamentRules,
  type FourReversiRoom,
  type FourShogiRoom,
  type Room,
  type RoomMembership,
  type RoomSocketClientMessage,
  type RoomTimeControl,
} from "@tetraboard/protocol";
import { gameCapacity } from "@tetraboard/protocol/games";
import { DurableObject } from "cloudflare:workers";
import { profileAvatarUrl } from "../../accounts/auth";
import { hasProfileRating, profileRatingsKey } from "../../accounts/profileRatings";
import { type AccountAdmission } from "../../accounts/roomAccounts";
import { nextAlarmAt } from "../../adapters/room/alarm";
import {
  hasCpuCapacity,
  recoverPlayingCpuCapacity,
  reserveCpuCapacity,
} from "../../adapters/room/cpuCapacity";
import { refreshLobbyIndex } from "../../adapters/room/indexJob";
import { createRoomJobs } from "../../adapters/room/jobs";
import { publicMetadata } from "../../adapters/room/metadata";
import {
  currentRoomMembership,
  departedKey,
  isHumanParticipant,
  playerTokenHash,
  purgeLegacyAnalytics,
  readMembership,
  readRoom,
} from "../../adapters/room/state";
import { withIndexTransaction } from "../../adapters/room/transaction";
import { endAnalyticsMatch, startAnalyticsMatch } from "../../adapters/room/usage";
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
  releaseRegistration,
  validateGuestRegistrationAccount,
} from "../../flows/guestRegistration/records";
import { prepareMatchmakingRoom } from "../../flows/matchmakingRoom/prepare";
import { rekeyMatchmakingPlayer } from "../../flows/matchmakingRoom/rekey";
import {
  abortMatchmakingRoom,
  clearMatchmakingSearches,
  getMatchmakingState,
} from "../../flows/matchmakingRoom/reservations";
import { advanceMatchmakingStart } from "../../flows/matchmakingRoom/start";
import { prepareTournamentRoom } from "../../flows/tournamentRoom/prepare";
import { rekeyTournamentPlayer } from "../../flows/tournamentRoom/rekey";
import {
  abortTournamentRoom,
  getTournamentReservationState,
  recordTournamentState,
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
import { prepareRoomSettings } from "../../rooms/applyRoomSettings";
import { isClockExpired } from "../../rooms/clock";
import { fourGomokuCpuJobKey } from "../../rooms/fourGomokuProgress";
import { fourReversiAiJobKey, fourReversiCpuJobKey } from "../../rooms/fourReversiProgress";
import { roomFormationAnalysis } from "../../rooms/fourShogiFormationAnalysis";
import { fourShogiAiJobKey, shogiEliminatedHandsKey } from "../../rooms/fourShogiProgress";
import { createGameAdapters } from "../../rooms/gameAdapters";
import type { ExternalCpuRequest } from "../../rooms/gameAdapters/cpuTypes";
import type { ActionCommand, GameAdapter, SettingsCommand } from "../../rooms/gameAdapters/types";
import { unreachable, type ProgressFor } from "../../rooms/gameProgress";
import { gomokuCpuJobKey } from "../../rooms/gomokuProgress";
import { matchStartKey } from "../../rooms/matchStore";
import {
  cpuMoveDelayMs,
  nextPublicUpdateAt,
  playerLabel,
  replayKey,
  roomStorageKey,
  shogiCpuJobKey,
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
import { shogiMatchStartKey, standardShogiMatchStartKey } from "../../rooms/shogiMatchStore";
import {
  isTournamentGameRoom,
  tournamentCredentialVersionKey,
  tournamentReservationKey,
  tournamentReturnKey,
  tournamentRoomKey,
  type PrepareTournamentRoomInput,
  type RekeyTournamentPlayerInput,
  type TournamentReturn,
} from "../../rooms/tournamentRoom";
import { analyticsPlayerKey, type AnalyticsIdentity } from "../../usageEvents/matches";
import { matchEndFacts } from "../../usageEvents/matchLifecycle";
import { TransactionUsageEvents } from "../../usageEvents/transactionEvents";
import { appendSystem } from "./chat";
import { closeSockets, webSocketClose, webSocketError } from "./connections";
import { fetch } from "./fetch";
import { inspectReport, moderateMessage } from "./reports";
import type { RoomRuntime, RoomSocketError } from "./runtime";
import { broadcastRoom, presence } from "./snapshots";
import { hasOpenConnection, sendCurrentMembership } from "./socket/membership";
import { webSocketMessage } from "./socket/message";
import {
  accountKey,
  chatKey,
  cpuCapacityKey,
  disconnectedAtKey,
  lastChatAtKey,
  membershipStorageKey,
  mutedKey,
  playerTokenKey,
  reconnectGraceMs,
  viewerSecretKey,
} from "./storageKeys";
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
      closeRoom: () => this.closeRoom(),
      chat: this.chat,
      reconcileDeadlines: (applyCpu) => this.reconcileDeadlines(applyCpu),
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

  private closeIfNoHumanParticipants<T extends Room>(room: T | null): T | null {
    if (
      room === null ||
      this.gameAdapter(room).cpu.keepsPlayingWithoutHumans(room) ||
      room.players.some((player) => isHumanParticipant(this.runtime, player))
    )
      return room;
    this.closeRoom();
    return null;
  }

  private recordDeparture(player: Room["players"][number]): void {
    if (this.ctx.storage.kv.get(departedKey(player.id))) return;
    this.ctx.storage.kv.delete(analyticsPlayerKey(player.id));
    if (readRoom(this.runtime)?.status === "playing")
      this.ctx.storage.kv.put(departedKey(player.id), true);
    appendSystem(this.runtime, "left", `${playerLabel(player)}が退室しました`);
  }

  private releaseResultAvatars(room: Room, retainedIds: Set<string>): void {
    for (const player of room.lastRound?.players ?? []) {
      if (!retainedIds.has(player.id)) releaseAccount(this.runtime, player.id, true);
    }
  }

  private closeRoom(): void {
    const room = readRoom(this.runtime);
    if (room && "matchmaking" in room && room.matchmaking) {
      const key = `matchmaking:${room.matchmaking.id}`;
      const saved = this.ctx.storage.kv.get<MatchmakingRoomReservation>(key);
      if (saved && saved.phase !== "playing")
        this.ctx.storage.kv.put(key, {
          ...clearMatchmakingSearches(this.runtime, saved),
          phase: "closed",
          connectedPlayerIds: room.players
            .filter(
              (p) =>
                p.kind === "human" &&
                hasOpenConnection(this.runtime, playerTokenHash(this.runtime, p.id) ?? ""),
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
            const hash = playerTokenHash(this.runtime, player.id);
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
          const hash = playerTokenHash(this.runtime, player.id);
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
    endAnalyticsMatch(this.runtime, "abandoned", Date.now());
    for (const player of room?.players ?? []) {
      this.ctx.storage.kv.delete(analyticsPlayerKey(player.id));
      if (player.kind !== "human") continue;
      releaseRegistration(this.runtime, player.id);
      releaseAccount(this.runtime, player.id, true);
      const tokenHash = playerTokenHash(this.runtime, player.id);
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
        endAnalyticsMatch(this.runtime, "completed", result.at, matchEndFacts(result.game));
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
      if (!isHumanParticipant(this.runtime, player)) return false;
      const hash = playerTokenHash(this.runtime, player.id);
      if (hash === null || readMembership(this.runtime, hash) === null) return false;
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
      releaseAccount(this.runtime, player.id, false);
      this.ctx.storage.kv.delete(departedKey(player.id));
      const hash = playerTokenHash(this.runtime, player.id);
      if (hash !== null) this.ctx.storage.kv.delete(membershipStorageKey(hash));
      this.ctx.storage.kv.delete(playerTokenKey(player.id));
      this.ctx.storage.kv.delete(disconnectedAtKey(player.id));
      this.ctx.storage.kv.delete(lastChatAtKey(player.id));
    }
    const host = humans.find((player) => {
      const hash = playerTokenHash(this.runtime, player.id);
      return hash !== null && readMembership(this.runtime, hash)?.role === "host";
    });
    const nextHost = host ?? humans[0];
    if (host === undefined) {
      const hash = playerTokenHash(this.runtime, nextHost.id)!;
      this.ctx.storage.kv.put(membershipStorageKey(hash), { playerId: nextHost.id, role: "host" });
    }
    const ordered = [nextHost, ...players.filter((player) => player.id !== nextHost.id)];
    for (const player of ordered) this.ctx.storage.kv.delete(departedKey(player.id));
    return ordered.map((player) => ({
      ...player,
      ready: player.kind === "cpu",
      reconnectDeadline:
        player.kind === "cpu" ||
        hasOpenConnection(this.runtime, playerTokenHash(this.runtime, player.id)!)
          ? null
          : this.ctx.storage.kv.get<number>(disconnectedAtKey(player.id))! + reconnectGraceMs,
    })) as P;
  }

  private play(
    tokenHash: string,
    command: ActionCommand,
  ): { status: "placed"; room: Room | null } | { status: RoomSocketError } {
    return withIndexTransaction(this.runtime, () => {
      const room = readRoom(this.runtime);
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
    return withIndexTransaction(this.runtime, () => {
      const room = readRoom(this.runtime);
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
    return withIndexTransaction(this.runtime, () => {
      const room = readRoom(this.runtime);
      if (!room) return { status: "not_found" };
      const result = this.gameAdapter(room).declare(room, tokenHash, command);
      if (result.kind === "rejected") return { status: result.error };
      const updated = this.applyProgress(result);
      if (updated) this.ctx.storage.kv.put(roomStorageKey, updated);
      return { status: "updated", room: updated };
    });
  }
  private updateGameSettings(tokenHash: string, command: SettingsCommand) {
    return withIndexTransaction(this.runtime, () => {
      const room = readRoom(this.runtime);
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

    const created = await withAccountAdmission(this.runtime, admission, () =>
      withIndexTransaction(this.runtime, () => {
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
      withIndexTransaction(this.runtime, () => {
        const room = readRoom(this.runtime);
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
    releaseRegistration(this.runtime, playerId);
    const departing = room.players.find((player) => player.id === playerId);
    if (departing) this.recordDeparture(departing);
    releaseAccount(
      this.runtime,
      playerId,
      !room.lastRound?.players.some((player) => player.id === playerId),
    );
    const tokenHash = playerTokenHash(this.runtime, playerId);
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
      const nextHash = playerTokenHash(this.runtime, successor.id);
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
          this.closeRoom();
          changed = true;
          return null;
        }
        const idle =
          this.gameAdapter(room).cpu.usesIdleDeadline(room) &&
          room.lastActivityAtMs + idleMs <= now;
        if (idle || this.closeIfNoHumanParticipants(room) === null) {
          if (idle) this.closeRoom();
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
                const hash = playerTokenHash(this.runtime, room.players[0].id);
                if (hash) promoted.push(hash);
              }
            } else {
              this.recordDeparture(player);
              releaseAccount(this.runtime, player.id, false);
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
              hasCapacity: (current) => hasCpuCapacity(this.runtime, current),
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
    let promoted: string | null = null;
    const result = withIndexTransaction(this.runtime, () => {
      const room = readRoom(this.runtime);
      if (room === null) return { status: "not_found" as const, room: null };
      if (room.status === "playing" && isClockExpired(room.clock, Date.now())) {
        return { status: "time_expired" as const, room };
      }
      const membership = readMembership(this.runtime, tokenHash);
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
        if (hostLeaving && updated !== null)
          promoted = playerTokenHash(this.runtime, updated.players[0].id);
      } else {
        this.recordDeparture(player);
        releaseAccount(this.runtime, player.id, false);
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
    return withIndexTransaction(this.runtime, () => {
      const room = readRoom(this.runtime);
      if (room === null) return { status: "not_found" };
      if (room.status !== "waiting") return { status: "already_started" };

      const membership = readMembership(this.runtime, tokenHash);
      if (membership === null) return { status: "unauthorized" };
      const player = room.players.find((entry) => entry.id === membership.playerId);
      if (player === undefined) return { status: "unauthorized" };
      if (registrationForPlayer(this.runtime, player.id)) return { status: "registration_pending" };
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
    return withIndexTransaction(this.runtime, () => {
      const room = readRoom(this.runtime);
      if (!room) return { status: "not_found" as const };
      if (readMembership(this.runtime, tokenHash)?.role !== "host")
        return { status: "forbidden" as const };
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
    return withIndexTransaction(this.runtime, () => {
      const room = readRoom(this.runtime);
      if (!room) return { status: "not_found" };
      if (room.status !== "waiting") return { status: "already_started" };
      if (readMembership(this.runtime, tokenHash)?.role !== "host") return { status: "forbidden" };
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
      const room = readRoom(this.runtime);
      if (room === null) return { status: "not_found" };
      if (room.status !== "waiting") return { status: "already_started" };

      const membership = readMembership(this.runtime, tokenHash);
      if (membership === null) return { status: "unauthorized" };
      if (membership.role !== "host") return { status: "forbidden" };
      if (room.players.some((player) => registrationForPlayer(this.runtime, player.id)))
        return { status: "registration_pending" };
      if (
        room.players.length !== gameCapacity(room.settings.game) ||
        room.players.some((player) => {
          if (player.kind === "cpu") return false;
          const hash = playerTokenHash(this.runtime, player.id);
          return !player.ready || hash === null || !hasOpenConnection(this.runtime, hash);
        })
      ) {
        return { status: "not_ready" };
      }

      const capacity = await reserveCpuCapacity(this.runtime, room);
      if (typeof capacity === "string") return { status: capacity };
      return withIndexTransaction(this.runtime, () => {
        if (capacity) this.ctx.storage.kv.put(cpuCapacityKey, capacity);
        const started = this.gameAdapter(room).start(room, { kind: "normal" });
        this.releaseResultAvatars(room, new Set(started.room.players.map((player) => player.id)));
        startAnalyticsMatch(this.runtime, started.roundId, started.room, started.at);
        return { status: "started", room: started.room };
      });
    });
  }

  private resign(
    tokenHash: string,
  ): { status: "resigned"; room: Room | null } | { status: RoomSocketError } {
    return withIndexTransaction(this.runtime, () => {
      const room = readRoom(this.runtime);
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
