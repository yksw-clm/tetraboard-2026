import { boardReportRetentionCutoff } from "@tetraboard/context-community";

export async function cleanupBoardReports(db: D1Database) {
  await db.batch([
    db
      .prepare("DELETE FROM board_reports WHERE reported_at_ms<=?")
      .bind(boardReportRetentionCutoff(Date.now())),
    db.prepare(
      "UPDATE board_reports SET author_account_id=NULL,author_name='退会したプレイヤー' WHERE author_account_id IN(SELECT id FROM deleted_accounts)",
    ),
    db.prepare(
      "UPDATE board_reports SET reporter_account_id=NULL WHERE reporter_account_id IN(SELECT id FROM deleted_accounts)",
    ),
  ]);
}
