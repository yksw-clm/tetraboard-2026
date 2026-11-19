import { deletionGuard, type DeletionScope } from "../../db/deletionGuard";

export function deactivateDeletedAccountStatements(
  db: D1Database,
  deletion: DeletionScope,
  retiredName: string,
) {
  const guard = deletionGuard(deletion);
  return [
    db.prepare(`DELETE FROM session WHERE userId=?1 AND ${guard.sql}`).bind(...guard.params()),
    db
      .prepare(`UPDATE user SET name=?2, username=NULL, avatarKey=NULL, image=NULL,
      publicProfileId=NULL, profileCompleted=0 WHERE id=?1
      AND (name IS NOT ?2 OR username IS NOT NULL OR avatarKey IS NOT NULL OR image IS NOT NULL
        OR publicProfileId IS NOT NULL OR profileCompleted IS NOT 0) AND ${guard.sql}`)
      .bind(...guard.params(retiredName)),
  ];
}
