export function guestPrivacyTransferStatements(db: D1Database, guestId: string, targetId: string) {
  return [
    db
      .prepare(
        "INSERT OR IGNORE INTO privacy_room_accounts SELECT ?,room_id FROM privacy_room_accounts WHERE account_id=?",
      )
      .bind(targetId, guestId),
    db
      .prepare(
        "INSERT OR IGNORE INTO privacy_room_players SELECT ?,room_id,instance_id,player_id,avatar_key FROM privacy_room_players WHERE account_id=?",
      )
      .bind(targetId, guestId),
    db.prepare("DELETE FROM privacy_room_accounts WHERE account_id=?").bind(guestId),
    db.prepare("DELETE FROM privacy_room_players WHERE account_id=?").bind(guestId),
  ];
}
