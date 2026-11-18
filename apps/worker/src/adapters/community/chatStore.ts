import type { ChatPageQuery, ChatWriter } from "@tetraboard/context-community";
import type { LobbyMessage } from "@tetraboard/protocol/general-lobby";
import { accountAvatarUrl } from "../account/profilePolicy";

const lobbyMessageColumns =
  "m.id,COALESCE(m.sender_public_id,s.public_id) AS senderId,u.name AS senderName,u.avatarKey,u.avatarPresetId,m.body AS text,m.sent_at_ms AS sentAtMs,m.account_id";
const lobbyVisible =
  "FROM lobby_chat_messages m JOIN lobby_chat_senders s ON s.account_id=m.account_id JOIN user u ON u.id=m.account_id WHERE NOT EXISTS(SELECT 1 FROM deleted_accounts d WHERE d.id=m.account_id) AND m.sent_at_ms>?";
type Row = {
  id: string;
  senderId: string;
  senderName: string;
  avatarKey: string | null;
  avatarPresetId: string | null;
  text: string;
  sentAtMs: number;
  account_id: string;
};
function publicMessage(row: Row, viewer?: string): LobbyMessage {
  const { avatarKey, avatarPresetId, account_id, ...message } = row;
  return {
    ...message,
    avatarUrl: accountAvatarUrl({ id: account_id, avatarKey, avatarPresetId }),
    own: account_id === viewer,
  };
}

function ensureSender(db: D1Database, accountId: string) {
  return db
    .prepare(
      "INSERT OR IGNORE INTO lobby_chat_senders(account_id,public_id) SELECT id,? FROM user WHERE id=? AND NOT EXISTS(SELECT 1 FROM deleted_accounts d WHERE d.id=user.id) AND NOT EXISTS(SELECT 1 FROM guest_account_merges WHERE guest_id=user.id)",
    )
    .bind(crypto.randomUUID(), accountId)
    .run();
}

export class D1ChatStore implements ChatWriter {
  constructor(private readonly db: D1Database) {}

  async readPage({ viewer, before, count, afterMs, tournamentId }: ChatPageQuery) {
    const db = this.db;
    const messagesQuery = db
      .prepare(`SELECT ${lobbyMessageColumns} ${lobbyVisible} AND m.tournament_id IS ?
 ${before ? "AND (m.sent_at_ms<? OR (m.sent_at_ms=? AND m.id<?))" : ""}
 ORDER BY m.sent_at_ms DESC,m.id DESC LIMIT ?`)
      .bind(
        afterMs,
        tournamentId,
        ...(before ? [before.sentAtMs, before.sentAtMs, before.id] : []),
        count,
      );
    const queries = [
      messagesQuery,
      db.prepare("SELECT accepting FROM lobby_chat_settings WHERE id=1"),
    ];
    if (viewer)
      queries.push(
        db
          .prepare("SELECT stopped,last_sent_at_ms FROM lobby_chat_senders WHERE account_id=?")
          .bind(viewer),
      );
    if (tournamentId !== null)
      queries.push(
        db
          .prepare(`SELECT t.chat_accepting,t.finalized_at_ms,
     EXISTS(SELECT 1 FROM tournament_entries e WHERE e.tournament_key=t.key AND e.account_id=? AND e.deleted=0) AS entered
     FROM tournaments t WHERE t.public_id=? AND t.published=1`)
          .bind(viewer ?? null, tournamentId),
      );
    const results = await db.batch(queries);
    const rows = results[0]!.results as Row[];
    const settings = results[1]!.results[0] as { accepting: number } | undefined;
    const sender = viewer
      ? (results[2]!.results[0] as { stopped: number; last_sent_at_ms: number } | undefined)
      : undefined;
    const tournament =
      tournamentId === null
        ? undefined
        : (results[viewer ? 3 : 2]!.results[0] as
            | { chat_accepting: number; finalized_at_ms: number | null; entered: number }
            | undefined);
    return {
      messages: rows.map((row) => publicMessage(row, viewer)),
      accepting: Boolean(settings?.accepting),
      sender: sender
        ? { stopped: Boolean(sender.stopped), lastSentAtMs: sender.last_sent_at_ms }
        : null,
      tournament: tournament
        ? {
            accepting: Boolean(tournament.chat_accepting),
            finalizedAtMs: tournament.finalized_at_ms,
            entered: Boolean(tournament.entered),
          }
        : null,
    };
  }

  async insertEligiblePost(
    {
      accountId,
      requestId,
      tournamentId,
      text,
      bodyHash,
      sentAtMs,
    }: Parameters<ChatWriter["insertEligiblePost"]>[0],
    { lastPostByMs, finalizedAfterMs }: Parameters<ChatWriter["insertEligiblePost"]>[1],
  ) {
    const db = this.db;
    await ensureSender(db, accountId);
    const id = crypto.randomUUID();
    // 投稿と送信時刻・再送台帳・件数制限を同じ batch で確定します。
    await db.batch([
      db
        .prepare(`INSERT OR IGNORE INTO lobby_chat_messages(id,account_id,body,sent_at_ms,request_id,body_hash,tournament_id)
 SELECT ?,u.id,?,?,?,?,? FROM user u JOIN lobby_chat_senders s ON s.account_id=u.id
 WHERE u.id=? AND u.profileCompleted=1 AND s.stopped=0 AND s.last_sent_at_ms<=?
 AND (COALESCE(u.isAnonymous,0)=0 OR u.guestNameCustomized=1)
 AND NOT EXISTS(SELECT 1 FROM guest_account_merges WHERE guest_id=u.id)
 AND (SELECT accepting FROM lobby_chat_settings WHERE id=1)=1
 AND (? IS NULL OR EXISTS(SELECT 1 FROM tournaments t JOIN tournament_entries e ON e.tournament_key=t.key
   WHERE t.public_id=? AND t.published=1 AND t.chat_accepting=1
   AND (t.finalized_at_ms IS NULL OR t.finalized_at_ms>?) AND e.account_id=u.id AND e.deleted=0))
 AND NOT EXISTS(SELECT 1 FROM deleted_accounts d WHERE d.id=u.id)
 AND NOT EXISTS(SELECT 1 FROM lobby_chat_requests r WHERE r.account_id=u.id AND r.request_id=?)`)
        .bind(
          id,
          text,
          sentAtMs,
          requestId,
          bodyHash,
          tournamentId,
          accountId,
          lastPostByMs,
          tournamentId,
          tournamentId,
          finalizedAfterMs,
          requestId,
        ),
      db
        .prepare(`UPDATE lobby_chat_senders SET last_sent_at_ms=? WHERE account_id=?
 AND EXISTS(SELECT 1 FROM lobby_chat_messages WHERE id=?)`)
        .bind(sentAtMs, accountId, id),
      db
        .prepare(`INSERT OR IGNORE INTO lobby_chat_requests(account_id,request_id,message_id,body_hash,sent_at_ms,tournament_id)
 SELECT account_id,request_id,id,body_hash,sent_at_ms,tournament_id FROM lobby_chat_messages WHERE id=?`)
        .bind(id),
      db
        .prepare(`DELETE FROM lobby_chat_messages WHERE id IN (
 SELECT m.id FROM lobby_chat_messages posted
 JOIN lobby_chat_messages m ON m.tournament_id IS posted.tournament_id
 WHERE posted.id=? ORDER BY m.sent_at_ms DESC,m.id DESC LIMIT -1 OFFSET 500
 )`)
        .bind(id),
    ]);
  }

  async readAcceptedPost(
    { accountId, requestId }: Parameters<ChatWriter["readAcceptedPost"]>[0],
    afterMs: number,
  ) {
    return this.db
      .prepare(
        "SELECT message_id AS messageId,body_hash AS bodyHash,sent_at_ms AS sentAtMs,tournament_id AS tournamentId FROM lobby_chat_requests WHERE account_id=? AND request_id=? AND sent_at_ms>? AND NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE id=?)",
      )
      .bind(accountId, requestId, afterMs, accountId)
      .first<{
        messageId: string;
        bodyHash: string;
        sentAtMs: number;
        tournamentId: number | null;
      }>();
  }

  async readMessage(id: string, viewer: string, tournamentId: number | null, afterMs: number) {
    const row = await this.db
      .prepare(`SELECT ${lobbyMessageColumns} ${lobbyVisible} AND m.id=? AND m.tournament_id IS ?`)
      .bind(afterMs, id, tournamentId)
      .first<Row>();
    return row ? publicMessage(row, viewer) : null;
  }
}
