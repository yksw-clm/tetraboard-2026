import { legalVersion } from "@tetraboard/protocol/privacy";
import { consentStatement } from "../privacy/consent";
import { profileInputSchema, type RoomError } from "@tetraboard/protocol";
import { accountIdentity, avatarKeyPattern, type StoredProfile } from "./auth";

export type AccountAdmission = {
  accountId: string;
  operationId: string;
  roomId: string;
  instanceId: string;
  playerId: string;
  name: string;
  avatarKey: string | null;
};
export type AccountReservation = AccountAdmission & { createdAtMs: number };
export class RoomAccountError extends Error {
  constructor(
    public readonly code: RoomError["error"],
    public readonly status: 400 | 403 | 409 | 503,
  ) {
    super(code);
  }
}
const pendingGraceMs = 30_000;

export async function roomEntryProfile(request: Request, env: Env, name?: string) {
  if (request.headers.get("X-Legal-Consent") !== legalVersion)
    throw new RoomAccountError("consent_required", 403);
  const user = await accountIdentity(request, env);
  if (user) {
    if (request.headers.get("Origin") !== env.APP_ORIGIN)
      throw new RoomAccountError("unauthorized", 403);
    if (!user.profileCompleted || !profileInputSchema.safeParse(user).success)
      throw new RoomAccountError("profile_required", 403);
    await consentStatement(env.APP_DB, user.id).run();
    return { name: user.name, user };
  }
  if (
    /(?:^|;\s*)(?:__Secure-)?tetraboard-2026\.session_token=/.test(
      request.headers.get("Cookie") ?? "",
    )
  )
    throw new RoomAccountError("unauthorized", 403);
  if (!name) throw new RoomAccountError("invalid_request", 400);
  return { name, user: null };
}

async function existingReservation(db: D1Database, accountId: string) {
  return db
    .prepare(`SELECT account_id AS accountId, operation_id AS operationId,
    room_id AS roomId, instance_id AS instanceId, player_id AS playerId,
    name, avatar_key AS avatarKey, created_at_ms AS createdAtMs
    FROM account_room_seats WHERE account_id = ?`)
    .bind(accountId)
    .first<AccountReservation>();
}

export async function releaseReservation(
  env: Env,
  reservation: AccountAdmission,
  releaseAvatar: boolean,
) {
  const statements = [
    env.APP_DB.prepare(
      "DELETE FROM account_room_seats WHERE account_id = ? AND operation_id = ? AND instance_id = ?",
    ).bind(reservation.accountId, reservation.operationId, reservation.instanceId),
  ];
  if (releaseAvatar)
    statements.push(
      env.APP_DB.prepare(
        "DELETE FROM room_avatar_refs WHERE operation_id = ? AND instance_id = ?",
      ).bind(reservation.operationId, reservation.instanceId),
    );
  await env.APP_DB.batch(statements);
}

// Cancelling in the room is a durable fence against a delayed admission RPC.
export async function cancelReservation(env: Env, reservation: AccountAdmission) {
  const result = await env.GAME_ROOM.getByName(reservation.roomId).cancelAccountReservation(
    reservation,
  );
  if (result.occupied) return false;
  await releaseReservation(env, reservation, !result.avatarReferenced);
  return true;
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
    const admission: AccountAdmission = {
      accountId: user.id,
      operationId: crypto.randomUUID(),
      roomId: room.id,
      instanceId: room.instanceId,
      playerId,
      name: user.name,
      avatarKey: user.avatarKey && avatarKeyPattern.test(user.avatarKey) ? user.avatarKey : null,
    };
    // Both the identity snapshot and image retention are registered atomically.
    // If profile editing won the race, its obsolete image cannot gain a new reference.
    const result = await env.APP_DB.batch([
      env.APP_DB.prepare(`INSERT OR IGNORE INTO account_room_seats
        (account_id, operation_id, room_id, instance_id, player_id, name, avatar_key, created_at_ms)
        SELECT id, ?, ?, ?, ?, name, ?, ? FROM user
        WHERE id = ? AND profileCompleted = 1 AND name = ? AND avatarKey IS ? AND NOT EXISTS (SELECT 1 FROM deleted_accounts d WHERE d.id = user.id)`).bind(
        admission.operationId,
        room.id,
        room.instanceId,
        playerId,
        admission.avatarKey,
        Date.now(),
        user.id,
        user.name,
        user.avatarKey,
      ),
      env.APP_DB.prepare(`INSERT OR IGNORE INTO room_avatar_refs
        (operation_id, room_id, instance_id, player_id, avatar_key)
        SELECT operation_id, room_id, instance_id, player_id, avatar_key
        FROM account_room_seats WHERE operation_id = ? AND avatar_key IS NOT NULL`).bind(
        admission.operationId,
      ),
      env.APP_DB.prepare(
        "INSERT OR IGNORE INTO privacy_room_accounts SELECT account_id,room_id FROM account_room_seats WHERE operation_id=?",
      ).bind(admission.operationId),
      env.APP_DB.prepare(
        "INSERT OR IGNORE INTO privacy_room_players SELECT account_id,room_id,instance_id,player_id,avatar_key FROM account_room_seats WHERE operation_id=?",
      ).bind(admission.operationId),
    ]);
    if (result[0].meta.changes === 1) {
      return admission;
    }
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
  const rows =
    await env.APP_DB.prepare(`SELECT account_id AS accountId, operation_id AS operationId,
    room_id AS roomId, instance_id AS instanceId, player_id AS playerId,
    name, avatar_key AS avatarKey FROM account_room_seats WHERE created_at_ms <= ? ORDER BY checked_at_ms, created_at_ms LIMIT 100`)
      .bind(Date.now() - pendingGraceMs)
      .all<AccountAdmission>();
  for (const reservation of rows.results) {
    try {
      await cancelReservation(env, reservation);
    } catch {
      console.error("Account seat recovery will be retried");
    } finally {
      await env.APP_DB.prepare(
        "UPDATE account_room_seats SET checked_at_ms = ? WHERE account_id = ? AND operation_id = ?",
      )
        .bind(Date.now(), reservation.accountId, reservation.operationId)
        .run();
    }
  }
}
