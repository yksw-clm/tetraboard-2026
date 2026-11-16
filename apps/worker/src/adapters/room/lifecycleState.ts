import type { RoomStatePort } from "@tetraboard/context-room";
import { roomMembershipSchema, roomSchema, tournamentRules } from "@tetraboard/protocol";
import type { AccountAdmission } from "../../accounts/roomAccounts";
import { appendSystem } from "../../durableObjects/gameRoom/chat";
import type { RoomRuntime } from "../../durableObjects/gameRoom/runtime";
import { hasOpenConnection } from "../../durableObjects/gameRoom/socket/membership";
import {
  accountKey,
  disconnectedAtKey,
  membershipStorageKey,
  playerTokenKey,
} from "../../durableObjects/gameRoom/storageKeys";
import { releaseAccount } from "../../flows/accountSeats/seats";
import {
  registrationForPlayer,
  releaseRegistration,
  endRegistration,
} from "../../flows/guestRegistration/records";
import { playerLabel, roomStorageKey } from "../../rooms/progressHelpers";
import type { AnalyticsIdentity } from "../../usageEvents/matches";
import { analyticsPlayerKey } from "../../usageEvents/matches";
import { matchEndFacts } from "../../usageEvents/matchLifecycle";
import {
  closeReservations,
  excludeWaitingTournamentPlayer,
  finishTournament,
} from "./lifecycleReservations";
import {
  clearClosedPlayerState,
  clearPlayerTransientState,
  clearRoom,
  initializeRoom,
} from "./lifecycleStorage";
import {
  departedKey,
  isHumanParticipant,
  playerTokenHash,
  readMembership,
  readRoom,
} from "./state";
import { hasCpuCapacity } from "./cpuCapacity";
import { tournamentReservation } from "../../flows/tournamentRoom/reservations";
import { tournamentPlayersConnected } from "../../flows/tournamentRoom/start";
import { isTournamentGameRoom } from "../../rooms/tournamentRoom";
import { collectMatchEnded, collectMatchStarted } from "./usage";

export type LifecycleIdentity = { admission?: AccountAdmission; analytics?: AnalyticsIdentity };
export function lifecycleState(
  runtime: RoomRuntime,
  identity: LifecycleIdentity = {},
): RoomStatePort {
  const kv = runtime.ctx.storage.kv;
  return {
    playerLabel,
    readRoom: () => readRoom(runtime),
    hasRoom: () => kv.get(roomStorageKey) !== undefined,
    saveRoom: (room) => {
      const saved = roomSchema.parse(room);
      kv.put(roomStorageKey, saved);
      return saved;
    },
    initializeRoom: (secret) => initializeRoom(runtime, secret),
    clearRoom: () => clearRoom(runtime),
    membership: (hash) => readMembership(runtime, hash),
    hasMembership: (hash) => kv.get(membershipStorageKey(hash)) !== undefined,
    saveMembership: (hash, membership) =>
      kv.put(membershipStorageKey(hash), roomMembershipSchema.parse(membership)),
    deleteMembership: (hash) => kv.delete(membershipStorageKey(hash)),
    playerToken: (id) => playerTokenHash(runtime, id),
    savePlayerToken: (id, hash) => kv.put(playerTokenKey(id), hash),
    deletePlayerToken: (id) => kv.delete(playerTokenKey(id)),
    hasConnection: (hash) => hasOpenConnection(runtime, hash),
    disconnectedAt: (id) => kv.get<number>(disconnectedAtKey(id)),
    saveDisconnectedAt: (id, at) => kv.put(disconnectedAtKey(id), at),
    clearPlayerTransientState: (id) => clearPlayerTransientState(runtime, id),
    clearClosedPlayerState: (id) => clearClosedPlayerState(runtime, id),
    hasDeparted: (id) => !!kv.get(departedKey(id)),
    saveDeparted: (id) => kv.put(departedKey(id), true),
    clearDeparted: (id) => kv.delete(departedKey(id)),
    isHumanParticipant: (player) => isHumanParticipant(runtime, player),
    ...deadlineState(runtime),
    hasRegistration: (id) => registrationForPlayer(runtime, id) !== null,
    releaseRegistration: (id) => releaseRegistration(runtime, id),
    releaseAccount: (id, removeAvatar) => releaseAccount(runtime, id, removeAvatar),
    saveAdmission: (id) => {
      if (identity.admission) kv.put(accountKey(id), { ...identity.admission, occupying: true });
    },
    saveIdentity: (id) => {
      if (identity.analytics) kv.put(analyticsPlayerKey(id), identity.analytics);
    },
    deleteIdentity: (id) => kv.delete(analyticsPlayerKey(id)),
    appendSystem: (event, text, at) => appendSystem(runtime, event, text, at, false),
    closeReservations: (room) => closeReservations(runtime, room),
    finishTournament: (room) => finishTournament(runtime, room),
    excludeWaitingTournamentPlayer: (room, id) => excludeWaitingTournamentPlayer(runtime, room, id),
    startMatchUsage: (id, room, at) => collectMatchStarted(runtime, id, room, at),
    endMatchUsage: (status, at, game) =>
      collectMatchEnded(runtime, status, at, game && matchEndFacts(game)),
  };
}

function deadlineState(runtime: RoomRuntime) {
  return {
    registrationDeadline: (id) => registrationForPlayer(runtime, id)?.holdUntilMs,
    expireRegistration: (id) => {
      const registration = registrationForPlayer(runtime, id);
      if (registration) endRegistration(runtime, registration, "expired");
    },
    waitingTournament: (room) => {
      const reservation = tournamentReservation(runtime, room);
      return reservation?.status === "waiting"
        ? {
            expiresAt: Math.min(
              reservation.preparedAtMs + tournamentRules.connectionGraceMs,
              reservation.context.endsAtMs,
            ),
            connected:
              isTournamentGameRoom(room) &&
              room.status === "waiting" &&
              room.tournamentStartsAtMs !== undefined &&
              tournamentPlayersConnected(runtime, room),
          }
        : null;
    },
    hasCpuCapacity: (room) => hasCpuCapacity(runtime, room),
  } satisfies Pick<
    RoomStatePort,
    "registrationDeadline" | "expireRegistration" | "waitingTournament" | "hasCpuCapacity"
  >;
}
