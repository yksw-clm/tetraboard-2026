export function guestChatMergeStatements(db: D1Database, guestId: string, accountId: string) {
  return [
    // 送信間隔と運営による停止は、両アカウントの厳しい方を引き継ぎます。
    db
      .prepare(`INSERT INTO lobby_chat_senders(account_id,public_id,last_sent_at_ms,stopped)
      SELECT ?,?,last_sent_at_ms,stopped FROM lobby_chat_senders WHERE account_id=?
      ON CONFLICT(account_id) DO UPDATE SET last_sent_at_ms=MAX(last_sent_at_ms,excluded.last_sent_at_ms),stopped=MAX(stopped,excluded.stopped)`)
      .bind(accountId, crypto.randomUUID(), guestId),
    db
      .prepare(`UPDATE lobby_chat_messages SET sender_public_id=COALESCE(sender_public_id,
      (SELECT public_id FROM lobby_chat_senders WHERE account_id=?)),account_id=? WHERE account_id=?`)
      .bind(guestId, accountId, guestId),
    db
      .prepare(`INSERT OR IGNORE INTO lobby_chat_requests(account_id,request_id,message_id,body_hash,sent_at_ms,tournament_id)
      SELECT ?,request_id,message_id,body_hash,sent_at_ms,tournament_id
      FROM lobby_chat_requests WHERE account_id=?`)
      .bind(accountId, guestId),
    db.prepare("DELETE FROM lobby_chat_requests WHERE account_id=?").bind(guestId),
    db
      .prepare("UPDATE lobby_chat_reports SET sender_account_id=? WHERE sender_account_id=?")
      .bind(accountId, guestId),
    // 同じ投稿への重複通報をまとめ、直近の通報時刻で時間制限を維持します。
    db
      .prepare(`UPDATE lobby_chat_reports SET reported_at_ms=MAX(reported_at_ms,
      (SELECT reported_at_ms FROM lobby_chat_reports g WHERE g.reporter_account_id=? AND g.message_id=lobby_chat_reports.message_id))
      WHERE reporter_account_id=? AND EXISTS(SELECT 1 FROM lobby_chat_reports g WHERE g.reporter_account_id=? AND g.message_id=lobby_chat_reports.message_id)`)
      .bind(guestId, accountId, guestId),
    db
      .prepare(`DELETE FROM lobby_chat_reports WHERE reporter_account_id=? AND EXISTS(
      SELECT 1 FROM lobby_chat_reports a WHERE a.reporter_account_id=? AND a.message_id=lobby_chat_reports.message_id)`)
      .bind(guestId, accountId),
    db
      .prepare("UPDATE lobby_chat_reports SET reporter_account_id=? WHERE reporter_account_id=?")
      .bind(accountId, guestId),
  ];
}
