import { deletionGuard, type DeletionScope } from "../../db/deletionGuard";

export function hideDeletedFeedbackStatement(
  db: D1Database,
  deletion: DeletionScope,
  reporterHash: string,
) {
  const guard = deletionGuard(deletion);
  return db
    .prepare(`UPDATE feedback SET deleted=1
    WHERE (account_id=?1 OR reporter_hash=?2) AND deleted<>1 AND ${guard.sql}`)
    .bind(...guard.params(reporterHash));
}
