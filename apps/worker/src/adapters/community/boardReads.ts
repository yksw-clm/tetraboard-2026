import { boardPage, boardPostingState, type BoardCursor } from "@tetraboard/context-community";
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

  async detail(id: string, viewer: string | null) {
    const [parent, replies, state] = await this.db.batch([
      ...this.threadStatements(id, viewer),
      postingStateStatement(this.db, viewer),
    ]);
    const post = this.readParent(parent!, viewer);
    if (!post) return null;
    return {
      post,
      ...this.replyPage(replies!, viewer),
      ...boardPostingState(state!.results[0] as PostingStateRow, Date.now),
    };
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
