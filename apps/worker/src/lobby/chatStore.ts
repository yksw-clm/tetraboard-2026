import type { LobbyMessage } from "@tetraboard/protocol/general-lobby";
import { profileAvatarUrl } from "../accounts/auth";
export const lobbyRetentionMs = 7 * 86400000;
export const lobbyMessageColumns =
  "m.id,COALESCE(m.sender_public_id,s.public_id) AS senderId,u.name AS senderName,u.avatarKey,m.body AS text,m.sent_at_ms AS sentAtMs,m.account_id";
export const lobbyVisible =
  "FROM lobby_chat_messages m JOIN lobby_chat_senders s ON s.account_id=m.account_id JOIN user u ON u.id=m.account_id WHERE NOT EXISTS(SELECT 1 FROM deleted_accounts d WHERE d.id=m.account_id) AND m.sent_at_ms>?";
type Row = {
  id: string;
  senderId: string;
  senderName: string;
  avatarKey: string | null;
  text: string;
  sentAtMs: number;
  account_id: string;
};
export function publicMessage(row: Row, viewer?: string): LobbyMessage {
  const { avatarKey, account_id, ...message } = row;
  return { ...message, avatarUrl: profileAvatarUrl(avatarKey), own: account_id === viewer };
}
export async function messageById(
  db: D1Database,
  id: string,
  viewer?: string,
  tournamentId: number | null = null,
) {
  const row = await db
    .prepare(`SELECT ${lobbyMessageColumns} ${lobbyVisible} AND m.id=? AND m.tournament_id IS ?`)
    .bind(Date.now() - lobbyRetentionMs, id, tournamentId)
    .first<Row>();
  return row ? publicMessage(row, viewer) : null;
}
export async function chatPage(
  db: D1Database,
  viewer?: string,
  before?: string,
  limit = 50,
  tournamentId: number | null = null,
) {
  const position = before?.split(":");
  const messagesQuery = db
    .prepare(`SELECT ${lobbyMessageColumns} ${lobbyVisible} AND m.tournament_id IS ?
 ${position ? "AND (m.sent_at_ms<? OR (m.sent_at_ms=? AND m.id<?))" : ""}
 ORDER BY m.sent_at_ms DESC,m.id DESC LIMIT ?`)
    .bind(
      Date.now() - lobbyRetentionMs,
      tournamentId,
      ...(position ? [Number(position[0]), Number(position[0]), position[1]] : []),
      limit + 1,
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
  // 同じ表示に必要な独立SELECTを一つのD1往復へまとめます。
  const results = await db.batch(queries);
  const rows = results[0]!.results as Row[];
  const settings = results[1]!.results[0] as { accepting: number } | undefined;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const sender = viewer
    ? (results[2]!.results[0] as { stopped: number; last_sent_at_ms: number } | undefined)
    : undefined;
  const tournament =
    tournamentId === null
      ? undefined
      : (results[viewer ? 3 : 2]!.results[0] as
          | {
              chat_accepting: number;
              finalized_at_ms: number | null;
              entered: number;
            }
          | undefined);
  const closesAtMs =
    tournament?.finalized_at_ms == null ? null : tournament.finalized_at_ms + 86400000;
  return {
    messages: page.reverse().map((row) => publicMessage(row, viewer)),
    nextCursor: rows.length > limit && last ? `${last.sentAtMs}:${last.id}` : null,
    acceptingPosts:
      Boolean(settings?.accepting) &&
      (tournamentId === null || Boolean(tournament?.chat_accepting)) &&
      (closesAtMs === null || Date.now() < closesAtMs),
    postingStopped: Boolean(sender?.stopped),
    availableAtMs: sender ? sender.last_sent_at_ms + 10000 : 0,
    serverTimeMs: Date.now(),
    ...(tournamentId === null ? {} : { entered: Boolean(tournament?.entered), closesAtMs }),
  };
}
export async function cleanupLobbyChat(db: D1Database) {
  const cutoff = Date.now() - lobbyRetentionMs;
  await db.batch([
    db
      .prepare(
        "DELETE FROM lobby_chat_messages WHERE sent_at_ms<=? OR account_id IN(SELECT id FROM deleted_accounts)",
      )
      .bind(cutoff),
    db
      .prepare(
        "DELETE FROM lobby_chat_requests WHERE sent_at_ms<=? OR account_id IN(SELECT id FROM deleted_accounts)",
      )
      .bind(cutoff),
    db.prepare("DELETE FROM lobby_chat_reports WHERE reported_at_ms<=?").bind(cutoff),
    db.prepare(
      "UPDATE lobby_chat_reports SET sender_name='退会したプレイヤー',sender_account_id=NULL,sender_public_id=NULL WHERE sender_account_id IN(SELECT id FROM deleted_accounts)",
    ),
    db.prepare(
      "UPDATE lobby_chat_reports SET reporter_account_id=NULL WHERE reporter_account_id IN(SELECT id FROM deleted_accounts)",
    ),
    db.prepare(
      "DELETE FROM lobby_chat_senders WHERE account_id IN(SELECT id FROM deleted_accounts UNION SELECT g.guest_id FROM guest_account_merges g JOIN deleted_accounts d ON d.id=g.account_id)",
    ),
  ]);
}
