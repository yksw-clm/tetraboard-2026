import type { RegistrationFlow, StoredProfile } from "@tetraboard/context-account";
export function updateLinkedSeat(
  db: D1Database,
  flow: RegistrationFlow,
  user: StoredProfile,
  avatarKey: string | null,
  avatarPresetId: string,
) {
  const seat = [user.id, flow.room_id, flow.instance_id, flow.player_id] as const;
  const where = "account_id=? AND room_id=? AND instance_id=? AND player_id=?";
  return db.batch<{ operation_id: string }>([
    db
      .prepare(`UPDATE account_room_seats SET name=?,avatar_key=?,avatar_preset_id=? WHERE ${where}
      AND EXISTS (SELECT 1 FROM user u WHERE u.id=account_room_seats.account_id AND u.name=? AND u.avatarKey IS ? AND u.avatarPresetId IS ?
        AND NOT EXISTS(SELECT 1 FROM deleted_accounts d WHERE d.id=u.id)) RETURNING operation_id`)
      .bind(
        user.name,
        avatarKey,
        avatarPresetId,
        ...seat,
        user.name,
        user.avatarKey,
        user.avatarPresetId ?? null,
      ),
    db
      .prepare(`INSERT OR REPLACE INTO room_avatar_refs
      SELECT operation_id,room_id,instance_id,player_id,avatar_key FROM account_room_seats
      WHERE ${where} AND avatar_key IS NOT NULL`)
      .bind(...seat),
    db
      .prepare(`UPDATE privacy_room_players SET avatar_key=? WHERE ${where}
      AND EXISTS (SELECT 1 FROM account_room_seats WHERE ${where} AND avatar_key IS ?)`)
      .bind(avatarKey, ...seat, ...seat, avatarKey),
  ]);
}
