import { membershipTokenSchema, roomSchema, type Room } from "@tetraboard/protocol";
import { isHumanParticipant, readMembership, readRoom } from "../../adapters/room/state";
import type { RoomRuntime } from "../../durableObjects/gameRoom/runtime";
import { roomStorageKey } from "../../rooms/progressHelpers";
import {
  activeRegistrationKey,
  guestRegistrationState,
  registrationClaimMs,
  registrationHoldMs,
  registrationKey,
  registrationTargetKey,
  type BeginGuestRegistrationResult,
  type GuestRegistrationInput,
  type StoredGuestRegistration,
} from "../../rooms/registrationTypes";
import { storedAccount } from "../accountSeats/seats";
import { registrationForPlayer } from "./records";

export function beginRegistrationSeat(
  runtime: RoomRuntime,
  input: GuestRegistrationInput,
  originalAccountIds: string[] | null,
  now: number,
): BeginGuestRegistrationResult {
  const room = readRoom(runtime);
  if (!room) return { status: "not_found" };
  if (room.instanceId !== input.instanceId) return { status: "room_changed" };
  if (room.status !== "waiting") return { status: "room_started" };
  const membership = readMembership(runtime, input.oldTokenHash);
  const player = room.players.find((p) => p.id === membership?.playerId);
  if (!membership || player?.kind !== "human" || !isHumanParticipant(runtime, player))
    return { status: "unauthorized" };
  const seat = storedAccount(runtime, player.id);
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
  if (registrationForPlayer(runtime, player.id)) return { status: "registration_conflict" };
  if (
    input.newTokenHash === input.oldTokenHash ||
    !membershipTokenSchema.safeParse(input.newTokenHash).success ||
    readMembership(runtime, input.newTokenHash)
  )
    return { status: "registration_conflict" };
  return persistRegistration(runtime, input, originalAccountIds, now, room, player);
}

function persistRegistration(
  runtime: RoomRuntime,
  input: GuestRegistrationInput,
  originalAccountIds: string[],
  now: number,
  room: Room,
  player: Room["players"][number],
): BeginGuestRegistrationResult {
  const targetKey = registrationTargetKey(input.matchId, player.id);
  const startedAtMs = runtime.ctx.storage.kv.get<number>(targetKey) ?? now;
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
  runtime.ctx.storage.kv.put(targetKey, startedAtMs);
  runtime.ctx.storage.kv.put(registrationKey(input.registrationId), record);
  runtime.ctx.storage.kv.put(activeRegistrationKey(player.id), input.registrationId);
  runtime.ctx.storage.kv.put(
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
}
