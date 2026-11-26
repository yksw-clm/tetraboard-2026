import {
  boardIndexAgeMs,
  boardIndexReplyCount,
  boardIndexTextLength,
  boardPage,
  boardPostingState,
  boardPostVisibility,
  shouldIndexBoardPost,
  type BoardCursor,
} from "@tetraboard/context-community";
import type { GameId } from "@tetraboard/protocol/games";
import {
  boardLiveRepliesSql,
  boardPost,
  boardPostColumns,
  boardPostFrom,
  boardPublishedSql,
  boardReply,
  type BoardRow,
} from "./boardRows";

const replyLimit = 50;

export const boardPostingStateColumns = `
 COALESCE((SELECT accepting FROM board_settings WHERE id=1),0) AS accepting,
 COALESCE(s.stopped,0) AS stopped,COALESCE(s.last_posted_at_ms,0) AS lastPostedAtMs`;
export const boardSenderJoin = "FROM (SELECT 1) LEFT JOIN board_senders s ON s.account_id=?1";

type PostingStateRow = Parameters<typeof boardPostingState>[0];
type SitemapRow = Pick<BoardRow, "id" | "postedAtMs" | "deletedAtMs" | "replyCount"> & {
  text: string;
  lastModifiedAtMs: number;
};

function postingStateStatement(db: D1Database, viewer: string | null) {
  return db.prepare(`SELECT ${boardPostingStateColumns} ${boardSenderJoin}`).bind(viewer);
}

export class D1BoardReader {
  constructor(private readonly db: D1Database) {}

  async timeline(gameId: GameId, viewer: string | null, limit: number, before?: BoardCursor) {
    const { db } = this;
    const [posts, state] = await db.batch([
      db
        .prepare(`SELECT ${boardPostColumns} ${boardPostFrom}
 WHERE p.parent_id IS NULL AND p.game_id=?2
 AND ((p.deleted_at_ms IS NULL AND d.id IS NULL) OR EXISTS(SELECT 1 ${boardLiveRepliesSql}))
 ${before ? "AND (p.posted_at_ms,p.id)<(?,?)" : ""}
 ORDER BY p.posted_at_ms DESC,p.id DESC LIMIT ?`)
        .bind(viewer, gameId, ...(before ? [before.postedAtMs, before.id] : []), limit + 1),
      postingStateStatement(db, viewer),
    ]);
    const visible = (posts!.results as BoardRow[]).flatMap((row) => {
      const post = boardPost(row, viewer);
      return post ? [post] : [];
    });
    const { items, nextCursor } = boardPage(visible, limit);
    return {
      posts: items,
      nextCursor,
      ...boardPostingState(state!.results[0] as PostingStateRow, Date.now),
    };
  }

  async detail(id: string, viewer: string | null, production: boolean) {
    const [parent, replies, state] = await this.db.batch([
      ...this.threadStatements(id, viewer),
      postingStateStatement(this.db, viewer),
    ]);
    const post = this.readParent(parent!, viewer);
    if (!post) return null;
    const postingState = boardPostingState(state!.results[0] as PostingStateRow, Date.now);
    return {
      post,
      indexable:
        post.status === "published" &&
        shouldIndexBoardPost({
          production,
          deletedAtMs: null,
          postedAtMs: post.postedAtMs,
          replyCount: post.replyCount,
          text: post.text,
          now: postingState.serverTimeMs,
        }),
      ...this.replyPage(replies!, viewer),
      ...postingState,
    };
  }

  async sitemapPosts(production: boolean) {
    const now = Date.now();
    // SQLite の length は NUL で止まるため、NUL を含む本文も候補に残します。
    const { results } = await this.db
      .prepare(`SELECT p.id,p.body AS text,p.posted_at_ms AS postedAtMs,
 COALESCE(p.deleted_at_ms,d.requested_at_ms) AS deletedAtMs,
 (SELECT COUNT(*) ${boardLiveRepliesSql}) AS replyCount,
 MAX(p.posted_at_ms,COALESCE((
   SELECT MAX(MAX(r.posted_at_ms,COALESCE(r.deleted_at_ms,rd.requested_at_ms,0)))
   FROM board_posts r LEFT JOIN deleted_accounts rd ON rd.id=r.account_id WHERE r.parent_id=p.id
 ),0)) AS lastModifiedAtMs
 FROM board_posts p LEFT JOIN deleted_accounts d ON d.id=p.account_id
 WHERE p.parent_id IS NULL AND ${boardPublishedSql("p")}
 AND p.posted_at_ms<=?1
 AND (replyCount>=?2 OR length(p.body)>=?3 OR instr(p.body,char(0))>0)
 ORDER BY p.posted_at_ms DESC,p.id DESC`)
      .bind(now - boardIndexAgeMs, boardIndexReplyCount, boardIndexTextLength)
      .all<SitemapRow>();
    return results.flatMap(({ id, lastModifiedAtMs, ...post }) =>
      boardPostVisibility(post.deletedAtMs, post.replyCount) === "published" &&
      shouldIndexBoardPost({ ...post, production, now })
        ? [{ id, lastModifiedAtMs }]
        : [],
    );
  }

  async replies(id: string, viewer: string | null, after?: BoardCursor) {
    const [parent, replies] = await this.db.batch(this.threadStatements(id, viewer, after));
    return this.readParent(parent!, viewer) ? this.replyPage(replies!, viewer) : null;
  }

  private threadStatements(id: string, viewer: string | null, after?: BoardCursor) {
    return [
      this.db
        .prepare(
          `SELECT ${boardPostColumns} ${boardPostFrom} WHERE p.parent_id IS NULL AND p.id=?2`,
        )
        .bind(viewer, id),
      this.db
        .prepare(`SELECT ${boardPostColumns} ${boardPostFrom} WHERE p.parent_id=?2 AND ${boardPublishedSql("p")}
 ${after ? "AND (p.posted_at_ms,p.id)>(?,?)" : ""}
 ORDER BY p.posted_at_ms,p.id LIMIT ?`)
        .bind(viewer, id, ...(after ? [after.postedAtMs, after.id] : []), replyLimit + 1),
    ];
  }

  private readParent(result: D1Result, viewer: string | null) {
    const row = result.results[0] as BoardRow | undefined;
    return row ? boardPost(row, viewer) : null;
  }

  private replyPage(result: D1Result, viewer: string | null) {
    const { items, nextCursor } = boardPage(result.results as BoardRow[], replyLimit);
    return { replies: items.map((row) => boardReply(row, viewer)), nextCursor };
  }
}
