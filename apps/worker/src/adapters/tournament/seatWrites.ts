import type { Player, WaitingProfile } from "@tetraboard/context-tournament";
export function prepareTournamentPlayer(
  db: D1Database,
  player: Player,
  profile: WaitingProfile,
  key: string,
) {
  const a = player.admission;
  return [
    db
      .prepare(
        "UPDATE tournament_wait_reservations SET match_operation_id=? WHERE account_id=? AND operation_id=?",
      )
      .bind(a.operationId, a.accountId, player.operationId),
    db
      .prepare(`INSERT INTO account_room_seats(account_id,operation_id,room_id,instance_id,player_id,name,avatar_key,avatar_preset_id,created_at_ms)
        SELECT u.id,?,?,?,?,u.name,?,?,? FROM user u JOIN tournament_wait_reservations w ON w.account_id=u.id
        JOIN tournament_entries e ON e.account_id=u.id AND e.tournament_key=w.tournament_key AND e.deleted=0
        WHERE u.id=? AND w.operation_id=? AND w.tournament_key=? AND w.match_operation_id=? AND u.profileCompleted=1 AND u.name=? AND u.avatarKey IS ? AND u.avatarPresetId IS ?
          AND NOT EXISTS(SELECT 1 FROM deleted_accounts d WHERE d.id=u.id)
        ON CONFLICT(account_id) DO NOTHING`)
      .bind(
        a.operationId,
        a.roomId,
        a.instanceId,
        a.playerId,
        a.avatarKey,
        a.avatarPresetId ?? null,
        Date.now(),
        a.accountId,
        player.operationId,
        key,
        a.operationId,
        profile.name,
        profile.avatarKey,
        profile.avatarPresetId,
      ),
    db
      .prepare(`INSERT OR IGNORE INTO room_avatar_refs(operation_id,room_id,instance_id,player_id,avatar_key)
        SELECT operation_id,room_id,instance_id,player_id,avatar_key FROM account_room_seats WHERE operation_id=? AND avatar_key IS NOT NULL`)
      .bind(a.operationId),
    db
      .prepare(
        "INSERT OR IGNORE INTO privacy_room_accounts SELECT account_id,room_id FROM account_room_seats WHERE operation_id=?",
      )
      .bind(a.operationId),
    db
      .prepare(
        "INSERT OR IGNORE INTO privacy_room_players SELECT account_id,room_id,instance_id,player_id,avatar_key FROM account_room_seats WHERE operation_id=?",
      )
      .bind(a.operationId),
  ].map((value) => ({ value }));
}
