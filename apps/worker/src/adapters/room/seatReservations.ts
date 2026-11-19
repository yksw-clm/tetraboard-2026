import type { StoredProfile } from "../../adapters/account/auth";
import { deletedAccountExistsSql } from "../../db/deletionGuard";
import {
  prepareSeatMergedAbort,
  prepareSeatWaitFence,
  seatFence,
} from "../../flows/accountSeats/fences";
import type { AccountAdmission, AccountReservation } from "../../flows/accountSeats/types";

export function existingReservation(db: D1Database, accountId: string) {
  return db
    .prepare(`SELECT account_id AS accountId, operation_id AS operationId,
    room_id AS roomId, instance_id AS instanceId, player_id AS playerId,
    name, avatar_key AS avatarKey, avatar_preset_id AS avatarPresetId, created_at_ms AS createdAtMs
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
      "DELETE FROM account_room_seats WHERE operation_id = ? AND room_id = ? AND instance_id = ? AND player_id = ?",
    ).bind(
      reservation.operationId,
      reservation.roomId,
      reservation.instanceId,
      reservation.playerId,
    ),
  ];
  if (releaseAvatar)
    statements.push(
      env.APP_DB.prepare(
        "DELETE FROM room_avatar_refs WHERE operation_id = ? AND instance_id = ?",
      ).bind(reservation.operationId, reservation.instanceId),
    );
  await env.APP_DB.batch(statements);
}

// プロフィールのスナップショットと画像の参照を同じ batch で保存します。
export async function insertReservation(
  db: D1Database,
  user: StoredProfile,
  admission: AccountAdmission,
) {
  const candidate = {
    sql: `FROM user WHERE id = ? AND profileCompleted = 1 AND name = ? AND avatarKey IS ? AND avatarPresetId IS ?`,
    values: [user.id, user.name, user.avatarKey, user.avatarPresetId ?? null],
  };
  const fence = seatFence("user.id", admission.operationId);
  const result = await db.batch<{ code: string | null }>([
    db
      .prepare(
        "DELETE FROM matchmaking_wait_reservations WHERE account_id=? AND lease_until_ms<=? AND match_operation_id IS NULL",
      )
      .bind(user.id, Date.now()),
    db
      .prepare(
        "DELETE FROM tournament_wait_reservations WHERE account_id=? AND lease_until_ms<=? AND match_operation_id IS NULL",
      )
      .bind(user.id, Date.now()),
    db
      .prepare(`INSERT OR IGNORE INTO account_room_seats
        (account_id, operation_id, room_id, instance_id, player_id, name, avatar_key, avatar_preset_id, created_at_ms)
        SELECT id, ?, ?, ?, ?, name, ?, ?, ? ${candidate.sql} AND ${fence.sql}`)
      .bind(
        admission.operationId,
        admission.roomId,
        admission.instanceId,
        admission.playerId,
        admission.avatarKey,
        admission.avatarPresetId ?? null,
        Date.now(),
        ...candidate.values,
        ...fence.values,
      ),
    prepareSeatMergedAbort(db, "user.id", admission.operationId, candidate),
    ...seatReferenceStatements(db, admission.operationId),
    prepareSeatWaitFence(db, user.id, admission.operationId),
  ]);
  return { inserted: result[2].meta.changes === 1, waiting: result.at(-1)?.results[0]?.code };
}

// 同じ操作で確定した席から、画像と退会処理に必要な参照を登録します。
export function seatReferenceStatements(db: D1Database, operationId: string) {
  return [
    db
      .prepare(`INSERT OR IGNORE INTO room_avatar_refs
          (operation_id, room_id, instance_id, player_id, avatar_key)
          SELECT operation_id, room_id, instance_id, player_id, avatar_key
          FROM account_room_seats WHERE operation_id = ? AND avatar_key IS NOT NULL`)
      .bind(operationId),
    db
      .prepare(
        `INSERT OR IGNORE INTO privacy_room_accounts SELECT account_id,room_id FROM account_room_seats s
        WHERE operation_id=? AND NOT ${deletedAccountExistsSql("s.account_id")}`,
      )
      .bind(operationId),
    db
      .prepare(
        `INSERT OR IGNORE INTO privacy_room_players SELECT account_id,room_id,instance_id,player_id,avatar_key FROM account_room_seats s
        WHERE operation_id=? AND NOT ${deletedAccountExistsSql("s.account_id")}`,
      )
      .bind(operationId),
  ];
}

export async function pendingReservations(db: D1Database, createdBefore: number) {
  const rows = await db
    .prepare(`SELECT account_id AS accountId, operation_id AS operationId,
    room_id AS roomId, instance_id AS instanceId, player_id AS playerId,
    name, avatar_key AS avatarKey, avatar_preset_id AS avatarPresetId FROM account_room_seats WHERE created_at_ms <= ? ORDER BY checked_at_ms, created_at_ms LIMIT 100`)
    .bind(createdBefore)
    .all<AccountAdmission>();
  return rows.results;
}

export async function markReservationChecked(db: D1Database, reservation: AccountAdmission) {
  await db
    .prepare(
      "UPDATE account_room_seats SET checked_at_ms = ? WHERE account_id = ? AND operation_id = ?",
    )
    .bind(Date.now(), reservation.accountId, reservation.operationId)
    .run();
}
