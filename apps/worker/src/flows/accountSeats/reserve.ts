import { accountAvatarPresetId } from "@tetraboard/protocol";
import { avatarKeyPattern, type StoredProfile } from "../../adapters/account/auth";
import {
  existingReservation,
  insertReservation,
  markReservationChecked,
  pendingReservations,
  releaseReservation,
} from "../../adapters/room/seatReservations";
import { RoomAccountError, roomEntryProfile } from "./entryProfile";
import { readSeatFence } from "./fences";
import type { AccountAdmission } from "./types";

const pendingGraceMs = 30_000;

// Cancelling in the room is a durable fence against a delayed admission RPC.
export async function cancelReservation(env: Env, reservation: AccountAdmission) {
  const result = await env.GAME_ROOM.getByName(reservation.roomId).cancelAccountReservation(
    reservation,
  );
  if (result.occupied) return false;
  await releaseReservation(env, reservation, !result.avatarReferenced);
  return true;
}

function newAdmission(
  user: StoredProfile,
  room: { id: string; instanceId: string },
  playerId: string,
): AccountAdmission {
  return {
    accountId: user.id,
    operationId: crypto.randomUUID(),
    roomId: room.id,
    instanceId: room.instanceId,
    playerId,
    name: user.name,
    ...(user.isAnonymous ? { isGuest: true } : {}),
    avatarPresetId: accountAvatarPresetId(user.id, user.avatarPresetId),
    avatarKey: user.avatarKey && avatarKeyPattern.test(user.avatarKey) ? user.avatarKey : null,
  };
}

export async function reserveAccountSeat(
  request: Request,
  env: Env,
  initialUser: StoredProfile,
  room: { id: string; instanceId: string },
  playerId: string,
  options?: { reuseForGuestRegistration: true },
): Promise<AccountAdmission> {
  let user = initialUser;
  for (let attempt = 0; attempt < 3; attempt++) {
    const admission = newAdmission(user, room, playerId);
    const { inserted, waiting } = await insertReservation(env.APP_DB, user, admission).catch(
      async (error: unknown) => {
        if (error instanceof Error && error.message.includes("guest_merged")) throw error;
        const waiting = await readSeatFence(env.APP_DB, user.id, admission.operationId);
        if (waiting) throw new RoomAccountError("account_busy", 409);
        throw error;
      },
    );
    if (inserted) return admission;
    if (waiting) throw new RoomAccountError("account_busy", 409);
    const existing = await existingReservation(env.APP_DB, user.id);
    if (existing) {
      // A committed seat is checked even during the grace period so departure
      // cleanup failures do not unnecessarily block the next room.
      const state = await env.GAME_ROOM.getByName(existing.roomId).accountReservationState(
        existing,
      );
      if (
        options?.reuseForGuestRegistration &&
        existing.roomId === room.id &&
        existing.instanceId === room.instanceId &&
        existing.playerId === playerId &&
        (state === "occupied" || state === "pending")
      )
        return existing;
      if (
        state === "occupied" ||
        (state === "pending" && existing.createdAtMs + pendingGraceMs > Date.now())
      )
        throw new RoomAccountError("account_seated", 409);
      if (!(await cancelReservation(env, existing)))
        throw new RoomAccountError("account_seated", 409);
    }
    const refreshed = await roomEntryProfile(request, env);
    if (!refreshed.user || refreshed.user.id !== initialUser.id)
      throw new RoomAccountError("unauthorized", 403);
    user = refreshed.user;
  }
  throw new RoomAccountError("internal_error", 503);
}

// Hourly recovery covers requests interrupted before they reached the room.
export async function recoverAccountReservations(env: Env) {
  const rows = await pendingReservations(env.APP_DB, Date.now() - pendingGraceMs);
  for (const reservation of rows) {
    try {
      await cancelReservation(env, reservation);
    } catch {
      console.error("Account seat recovery will be retried");
    } finally {
      await markReservationChecked(env.APP_DB, reservation);
    }
  }
}
