export function guestFeedbackTransferStatement(db: D1Database, guestId: string, targetId: string) {
  return db.prepare("UPDATE feedback SET account_id=? WHERE account_id=?").bind(targetId, guestId);
}
