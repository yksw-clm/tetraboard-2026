import { lobbyRetentionMs, type ChatScope } from "@tetraboard/context-community";
import type { LobbyModeration } from "@tetraboard/protocol/general-lobby";

export async function readChatModeration(db: D1Database, id: ChatScope, now: () => number) {
  const settings =
    id === null
      ? await db
          .prepare("SELECT accepting FROM lobby_chat_settings WHERE id=1")
          .first<{ accepting: number }>()
      : await db
          .prepare(
            "SELECT chat_accepting AS accepting FROM tournaments WHERE public_id=? AND published=1",
          )
          .bind(id)
          .first<{ accepting: number }>();
  if (!settings) return null;
  const reports = await db
    .prepare(`SELECT id,message_id AS messageId,
 CASE WHEN sender_account_id IN(SELECT id FROM deleted_accounts) THEN NULL ELSE sender_public_id END AS senderId,
 CASE WHEN sender_account_id IN(SELECT id FROM deleted_accounts) THEN '退会したプレイヤー' ELSE sender_name END AS senderName,
 body AS text,sent_at_ms AS sentAtMs,reported_at_ms AS reportedAtMs,status,tournament_id AS tournamentId FROM lobby_chat_reports WHERE reported_at_ms>? AND (? IS NULL OR tournament_id=?) ORDER BY reported_at_ms DESC,id DESC LIMIT 500`)
    .bind(now() - lobbyRetentionMs, id, id)
    .all();
  const stopped = await db
    .prepare(
      "SELECT s.public_id AS senderId,u.name AS senderName FROM lobby_chat_senders s JOIN user u ON u.id=s.account_id WHERE s.stopped=1 AND NOT EXISTS(SELECT 1 FROM guest_account_merges WHERE guest_id=u.id) AND NOT EXISTS(SELECT 1 FROM deleted_accounts d WHERE d.id=u.id)",
    )
    .all();
  return {
    acceptingPosts: Boolean(settings.accepting),
    reports: reports.results,
    stoppedSenders: stopped.results,
  };
}

export async function moderateChat(db: D1Database, value: LobbyModeration, now: () => number) {
  if (value.action === "accepting") {
    if (value.tournamentId !== undefined) {
      const result = await db
        .prepare("UPDATE tournaments SET chat_accepting=? WHERE public_id=? AND published=1")
        .bind(Number(value.accepting), value.tournamentId)
        .run();
      if (!result.meta.changes) return false;
    } else
      await db
        .prepare("UPDATE lobby_chat_settings SET accepting=? WHERE id=1")
        .bind(Number(value.accepting))
        .run();
  } else if (value.action === "stop")
    await db
      .prepare(`UPDATE lobby_chat_senders SET stopped=? WHERE account_id IN (
        SELECT account_id FROM lobby_chat_senders WHERE public_id=?
        UNION SELECT COALESCE(g.account_id,s.account_id) FROM lobby_chat_senders s
          LEFT JOIN guest_account_merges g ON g.guest_id=s.account_id WHERE s.public_id=?
        UNION SELECT g.guest_id FROM guest_account_merges g WHERE g.account_id IN (
          SELECT COALESCE(a.account_id,s.account_id) FROM lobby_chat_senders s
          LEFT JOIN guest_account_merges a ON a.guest_id=s.account_id WHERE s.public_id=?))`)
      .bind(Number(value.stopped), value.senderId, value.senderId, value.senderId)
      .run();
  else if (value.action === "delete")
    await db.prepare("DELETE FROM lobby_chat_messages WHERE id=?").bind(value.messageId).run();
  else
    await db
      .prepare("UPDATE lobby_chat_reports SET status='resolved' WHERE id=? AND reported_at_ms>?")
      .bind(value.reportId, now() - lobbyRetentionMs)
      .run();
  return true;
}
