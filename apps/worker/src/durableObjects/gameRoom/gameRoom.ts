import { type Room } from "@tetraboard/protocol";
import { DurableObject } from "cloudflare:workers";
import { type AccountAdmission } from "../../accounts/roomAccounts";
import { purgeLegacyAnalytics } from "../../adapters/room/state";
import { purgeAccount } from "../../flows/accountPurge/purge";
import {
  accountReservationState,
  cancelAccountReservation,
} from "../../flows/accountSeats/reservations";
import { beginGuestRegistration } from "../../flows/guestRegistration/begin";
import { armGuestMatchClaims, guestMergeConflict } from "../../flows/guestRegistration/claims";
import { completeGuestRegistration } from "../../flows/guestRegistration/complete";
import {
  cancelGuestRegistration,
  getGuestRegistration,
  validateGuestRegistrationAccount,
} from "../../flows/guestRegistration/records";
import { prepareMatchmakingRoom } from "../../flows/matchmakingRoom/prepare";
import { rekeyMatchmakingPlayer } from "../../flows/matchmakingRoom/rekey";
import {
  abortMatchmakingRoom,
  getMatchmakingState,
} from "../../flows/matchmakingRoom/reservations";
import { prepareTournamentRoom } from "../../flows/tournamentRoom/prepare";
import { rekeyTournamentPlayer } from "../../flows/tournamentRoom/rekey";
import {
  abortTournamentRoom,
  getTournamentReservationState,
} from "../../flows/tournamentRoom/reservations";
import type { MatchmakingRoomInput } from "@tetraboard/context-matchmaking";
import {
  type BeginGuestRegistrationResult,
  type CompleteGuestRegistrationResult,
  type GuestRegistrationInput,
  type GuestRegistrationState,
} from "../../rooms/registrationTypes";
import { wrapRoomAlarmEvents } from "../../rooms/roomAlarmEvents";
import {
  type PrepareTournamentRoomInput,
  type RekeyTournamentPlayerInput,
} from "../../rooms/tournamentRoom";
import { type AnalyticsIdentity } from "../../usageEvents/matches";
import { webSocketClose, webSocketError } from "./connections";
import { fetch } from "./fetch";
import { inspectReport, moderateMessage } from "./reports";
import { webSocketMessage } from "./socket/message";
import { issueViewerToken } from "./viewerTokens";
import { createRoomAlarms, createRoomRuntime } from "./createRuntime";
import * as queries from "./queries";
import * as profiles from "./profiles";
import * as admissions from "./admissions";

export class GameRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      purgeLegacyAnalytics(this.runtime);
    });
  }

  private readonly alarmEvents = createRoomAlarms(this, this.ctx, () => this.runtime);
  private readonly runtime = createRoomRuntime(this.ctx, () => this.env, this.alarmEvents);

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
  ) {
    return queries.getFourShogiAnalysisReplay(
      this.runtime,
      instanceId,
      roundId,
      positionRevision,
      cursor,
    );
  }

  async getShogiReplay(instanceId: string, roundId: string, cursor: number) {
    return queries.getShogiReplay(this.runtime, instanceId, roundId, cursor);
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
  ) {
    return admissions.createRoom(this.runtime, room, tokenHash, admission, analytics);
  }

  async getRoom() {
    return queries.getRoom(this.runtime);
  }

  async getShareMetadata(instanceId: string) {
    return profiles.getShareMetadata(this.runtime, instanceId);
  }

  async getRoomSnapshot(formationAnalysis = false, stamps = false, eliminatedHands = false) {
    return queries.getRoomSnapshot(this.runtime, formationAnalysis, stamps, eliminatedHands);
  }

  async resolvePlayerProfile(instanceId: string, playerId: string) {
    return profiles.resolvePlayerProfile(this.runtime, instanceId, playerId);
  }

  async refreshLobbyIndex(expectedInstanceId: string | null, expectedRevision: number) {
    return queries.refreshLobbyIndex(this.runtime, expectedInstanceId, expectedRevision);
  }

  async getPublicMetadata(profilePreview = false) {
    return queries.getPublicMetadata(this.runtime, profilePreview);
  }

  async getRoomMembership(tokenHash: string) {
    return queries.getRoomMembership(this.runtime, tokenHash);
  }

  async joinRoom(
    name: string,
    tokenHash: string,
    instanceId?: string,
    admission?: AccountAdmission,
    analytics?: AnalyticsIdentity,
  ) {
    return admissions.joinRoom(this.runtime, name, tokenHash, instanceId, admission, analytics);
  }

  async alarm(): Promise<void> {
    await this.runtime.reconcileDeadlines(true);
  }

  async leaveRoom(tokenHash: string) {
    return admissions.leaveRoom(this.runtime, tokenHash);
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
