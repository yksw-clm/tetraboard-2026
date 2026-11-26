import { deletionGuard, type DeletionScope } from "../../db/deletionGuard";

export function withdrawBoardStatements(db: D1Database, deletion: DeletionScope) {
  const guard = deletionGuard(deletion);
  const [accountId, ...receiptParams] = guard.params();
  return [
    db
      .prepare(`UPDATE board_posts SET body=NULL,match_id=NULL,position=NULL,request_id=NULL,body_hash=NULL,
 deleted_at_ms=COALESCE(deleted_at_ms,?2),deletion_reason='withdrawn'
 WHERE account_id=?1 AND ${guard.sql}`)
      .bind(accountId, Date.now(), ...receiptParams),
    db
      .prepare(`DELETE FROM board_likes WHERE account_id=?1 AND ${guard.sql}`)
      .bind(...guard.params()),
  ];
}

export function deleteAccountBoardStatements(db: D1Database, accountId: string) {
  return [
    db.prepare("UPDATE board_posts SET account_id=NULL WHERE account_id=?1").bind(accountId),
    db.prepare("DELETE FROM board_senders WHERE account_id=?1").bind(accountId),
    db.prepare("DELETE FROM board_likes WHERE account_id=?1").bind(accountId),
  ];
}
