import { chatRetentionCutoff } from "@tetraboard/context-community";

export async function cleanupLobbyChat(db: D1Database) {
  const cutoff = chatRetentionCutoff(Date.now());
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

export function deleteAccountChatStatements(db: D1Database, accountId: string) {
  return [
    db.prepare("DELETE FROM lobby_chat_messages WHERE account_id=?").bind(accountId),
    db.prepare("DELETE FROM lobby_chat_requests WHERE account_id=?").bind(accountId),
    db
      .prepare(
        "UPDATE lobby_chat_reports SET sender_name='退会したプレイヤー',sender_account_id=NULL,sender_public_id=NULL WHERE sender_account_id=?",
      )
      .bind(accountId),
    db
      .prepare("UPDATE lobby_chat_reports SET reporter_account_id=NULL WHERE reporter_account_id=?")
      .bind(accountId),
    db
      .prepare(
        "DELETE FROM lobby_chat_senders WHERE account_id=? OR account_id IN(SELECT guest_id FROM guest_account_merges WHERE account_id=?)",
      )
      .bind(accountId, accountId),
  ];
}
