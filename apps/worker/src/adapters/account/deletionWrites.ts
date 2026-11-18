import { acceptedDeletionSql, type DeletionBatch } from "../../db/deletionGuard";

export function deactivateDeletedAccountStatements(
  db: D1Database,
  { accountId, batchReceipt }: DeletionBatch,
  retiredName: string,
) {
  return [
    db
      .prepare(`DELETE FROM session WHERE userId=?1 AND ${acceptedDeletionSql}`)
      .bind(accountId, batchReceipt),
    db
      .prepare(`UPDATE user SET name=?3, username=NULL, avatarKey=NULL, image=NULL,
      publicProfileId=NULL, profileCompleted=0 WHERE id=?1 AND ${acceptedDeletionSql}
      AND (name IS NOT ?3 OR username IS NOT NULL OR avatarKey IS NOT NULL OR image IS NOT NULL
        OR publicProfileId IS NOT NULL OR profileCompleted IS NOT 0)`)
      .bind(accountId, batchReceipt, retiredName),
  ];
}
