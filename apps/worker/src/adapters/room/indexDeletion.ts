import { acceptedDeletionSql, type DeletionBatch } from "../../db/deletionGuard";

export function hideDeletedRoomPlayersStatements(
  db: D1Database,
  { accountId, batchReceipt }: DeletionBatch,
  retiredName: string,
) {
  const retiredParticipant = `json_extract(p.value,'$.appearance.kind')='human' AND EXISTS (
    SELECT 1 FROM privacy_room_players r JOIN deleted_accounts d
      ON d.id=r.account_id OR EXISTS (
        SELECT 1 FROM guest_account_merges m WHERE m.guest_id=r.account_id AND m.account_id=d.id
      )
    WHERE r.room_id=room_index.room_id AND r.instance_id=room_index.instance_id
      AND r.player_id=json_extract(p.value,'$.playerId')
  )`;
  return [
    db
      .prepare(`UPDATE room_index SET host_name=?3,host_avatar_url=NULL,host_player_id=NULL
      WHERE ${acceptedDeletionSql} AND EXISTS (
        SELECT 1 FROM privacy_room_players p WHERE p.account_id=?1 AND p.room_id=room_index.room_id
          AND p.instance_id=room_index.instance_id AND p.player_id=room_index.host_player_id
      )`)
      .bind(accountId, batchReceipt, retiredName),
    db
      .prepare(`UPDATE room_index SET participants_json=(
      SELECT json_group_array(json(CASE WHEN ${retiredParticipant}
        THEN json_set(p.value,'$.appearance.avatarUrl',NULL,'$.appearance.retired',json('true'))
        ELSE p.value END)) FROM json_each(room_index.participants_json) p
      )
      WHERE ${acceptedDeletionSql} AND participants_json IS NOT NULL AND EXISTS (
        SELECT 1 FROM json_each(room_index.participants_json) p WHERE ${retiredParticipant}
          AND (json_extract(p.value,'$.appearance.avatarUrl') IS NOT NULL
            OR COALESCE(json_extract(p.value,'$.appearance.retired'),0)<>1)
      )`)
      .bind(accountId, batchReceipt),
  ];
}
