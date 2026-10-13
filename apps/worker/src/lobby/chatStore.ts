import type { LobbyMessage } from "@tetraboard/protocol/general-lobby";
import { profileAvatarUrl } from "../accounts/auth";
export const lobbyRetentionMs = 7 * 86400000;
export const lobbyMessageColumns =
  "m.id,s.public_id AS senderId,u.name AS senderName,u.avatarKey,m.body AS text,m.sent_at_ms AS sentAtMs,m.account_id";
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
export async function messageById(db: D1Database, id: string, viewer?: string) {
  const row = await db
    .prepare(`SELECT ${lobbyMessageColumns} ${lobbyVisible} AND m.id=?`)
    .bind(Date.now() - lobbyRetentionMs, id)
    .first<Row>();
  return row ? publicMessage(row, viewer) : null;
}
export async function chatPage(db: D1Database, viewer?: string, before?: string, limit = 50) {
  const position = before?.split(":");
  const rows = await db
    .prepare(`SELECT ${lobbyMessageColumns} ${lobbyVisible}
 ${position ? "AND (m.sent_at_ms<? OR (m.sent_at_ms=? AND m.id<?))" : ""}
 ORDER BY m.sent_at_ms DESC,m.id DESC LIMIT ?`)
    .bind(
      Date.now() - lobbyRetentionMs,
      ...(position ? [Number(position[0]), Number(position[0]), position[1]] : []),
      limit + 1,
    )
    .all<Row>();
  const page = rows.results.slice(0, limit);
  const last = page.at(-1);
  const settings = await db
    .prepare("SELECT accepting FROM lobby_chat_settings WHERE id=1")
    .first<{ accepting: number }>();
  const sender = viewer
    ? await db
        .prepare("SELECT stopped,last_sent_at_ms FROM lobby_chat_senders WHERE account_id=?")
        .bind(viewer)
        .first<{ stopped: number; last_sent_at_ms: number }>()
    : null;
  return {
    messages: page.reverse().map((row) => publicMessage(row, viewer)),
    nextCursor: rows.results.length > limit && last ? `${last.sentAtMs}:${last.id}` : null,
    acceptingPosts: Boolean(settings?.accepting),
    postingStopped: Boolean(sender?.stopped),
    availableAtMs: sender ? sender.last_sent_at_ms + 10000 : 0,
    serverTimeMs: Date.now(),
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
      "DELETE FROM lobby_chat_senders WHERE account_id IN(SELECT id FROM deleted_accounts)",
    ),
  ]);
}
