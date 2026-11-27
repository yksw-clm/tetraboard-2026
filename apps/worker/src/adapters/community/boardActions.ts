import { accountNotDeletedSql } from "../../db/deletionGuard";
import { boardAccountEligibleSql, boardEligibleAccountExistsSql } from "./boardPosting";
import { boardLikeColumns, boardPublishedSql } from "./boardRows";

// 公開中の返信が1件あれば、親が削除済みでも枠は残ります。
const boardLikeableSql = `${boardPublishedSql("p")} AND (p.parent_id IS NULL OR EXISTS(
 SELECT 1 FROM board_posts parent WHERE parent.id=p.parent_id AND parent.parent_id IS NULL))`;

function insertBoardLike(db: D1Database, accountId: string, postId: string, now: number) {
  return db
    .prepare(`INSERT INTO board_likes(post_id,account_id,liked_at_ms)
 SELECT p.id,u.id,?3 FROM user u JOIN board_posts p ON p.id=?2
 WHERE u.id=?1 AND ${boardAccountEligibleSql} AND ${accountNotDeletedSql("u.id")}
 AND ${boardLikeableSql}
 ON CONFLICT(post_id,account_id) DO NOTHING`)
    .bind(accountId, postId, now);
}

function deleteBoardLike(db: D1Database, accountId: string, postId: string) {
  return db
    .prepare(
      `DELETE FROM board_likes WHERE account_id=?1 AND post_id=?2 AND ${boardEligibleAccountExistsSql}`,
    )
    .bind(accountId, postId);
}

export async function setBoardLike(
  db: D1Database,
  accountId: string,
  postId: string,
  like: boolean,
  now: () => number,
) {
  const [, eligibility, counts] = await db.batch([
    like ? insertBoardLike(db, accountId, postId, now()) : deleteBoardLike(db, accountId, postId),
    db.prepare(`SELECT ${boardEligibleAccountExistsSql} AS eligible`).bind(accountId),
    db
      .prepare(
        `SELECT ${boardLikeColumns} FROM board_posts p WHERE p.id=?2 AND ${boardLikeableSql}`,
      )
      .bind(accountId, postId),
  ]);
  const account = eligibility!.results[0] as { eligible: number } | undefined;
  if (!account?.eligible) return { status: "ineligible" } as const;
  const target = counts!.results[0] as { liked: number; likeCount: number } | undefined;
  if (like && !target) return { status: "notFound" } as const;
  return {
    status: "accepted",
    liked: Boolean(target?.liked),
    likeCount: target?.likeCount ?? 0,
  } as const;
}

export async function deleteOwnBoardPost(
  db: D1Database,
  accountId: string,
  id: string,
  now: number,
) {
  const [, ownership] = await db.batch([
    db
      .prepare(`UPDATE board_posts SET body=NULL,match_id=NULL,position=NULL,deleted_at_ms=?3,
 deletion_reason='author' WHERE account_id=?1 AND id=?2 AND deleted_at_ms IS NULL
 AND ${accountNotDeletedSql("?1")}`)
      .bind(accountId, id, now),
    db
      .prepare(
        `SELECT id FROM board_posts WHERE account_id=?1 AND id=?2 AND ${accountNotDeletedSql("?1")}`,
      )
      .bind(accountId, id),
  ]);
  return ownership!.results.length === 1;
}
