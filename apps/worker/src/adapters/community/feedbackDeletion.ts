import { acceptedDeletionSql, type DeletionBatch } from "../../db/deletionGuard";

export function hideDeletedFeedbackStatement(
  db: D1Database,
  { accountId, batchReceipt }: DeletionBatch,
  reporterHash: string,
) {
  return db
    .prepare(`UPDATE feedback SET deleted=1
    WHERE (account_id=?1 OR reporter_hash=?3) AND deleted<>1 AND ${acceptedDeletionSql}`)
    .bind(accountId, batchReceipt, reporterHash);
}
