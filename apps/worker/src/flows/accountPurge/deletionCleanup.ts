import type { AuthEnv } from "../../adapters/account/auth";
import { deleteAccountChatStatements } from "../../adapters/community/chatCleanup";
import { feedbackAccountHash } from "./feedbackAccountHash";

export async function purgeTournaments(env: AuthEnv, accountId: string) {
  const tournaments = await env.APP_DB.prepare(
    "SELECT DISTINCT tournament_key FROM tournament_entries WHERE account_id=?",
  )
    .bind(accountId)
    .all<{ tournament_key: string }>();
  for (const tournament of tournaments.results)
    await env.TOURNAMENT_COORDINATOR.getByName(tournament.tournament_key).purgeAccount(accountId);
  await env.APP_DB.batch([
    env.APP_DB.prepare("DELETE FROM tournament_wait_reservations WHERE account_id=?").bind(
      accountId,
    ),
    env.APP_DB.prepare(
      "UPDATE tournament_entries SET account_id=NULL,deleted=1 WHERE account_id=?",
    ).bind(accountId),
    env.APP_DB.prepare(
      "UPDATE tournament_match_players SET account_id=NULL WHERE account_id=?",
    ).bind(accountId),
  ]);
}

export async function deleteFeedback(env: AuthEnv, accountId: string) {
  // 受付の表示抑止と別に、本人の投稿本文・画像を物理削除します。
  const feedback = await env.APP_DB.prepare(
    "SELECT id,attachment_key FROM feedback WHERE reporter_hash=? OR account_id=?",
  )
    .bind(await feedbackAccountHash(env, accountId), accountId)
    .all<{ id: string; attachment_key: string | null }>();
  for (const row of feedback.results) {
    if (row.attachment_key) await env.OBJECT_STORAGE.delete(row.attachment_key);
    await env.APP_DB.batch([
      env.APP_DB.prepare("DELETE FROM feedback_history WHERE feedback_id=?").bind(row.id),
      env.APP_DB.prepare("DELETE FROM feedback WHERE id=?").bind(row.id),
      env.APP_DB.prepare("DELETE FROM feedback_uploads WHERE key=?").bind(row.attachment_key ?? ""),
    ]);
  }
}

export async function deleteAccountData(env: AuthEnv, accountId: string) {
  const reporterHash = await feedbackAccountHash(env, accountId);
  await env.APP_DB.batch([
    env.APP_DB.prepare("DELETE FROM feedback_limits WHERE key IN (?,?)").bind(
      `${reporterHash}:600000`,
      `${reporterHash}:86400000`,
    ),
    env.APP_DB.prepare("DELETE FROM account_notification_reads WHERE account_id=?").bind(accountId),
    env.APP_DB.prepare("DELETE FROM account_notification_state WHERE account_id=?").bind(accountId),
    env.APP_DB.prepare("DELETE FROM notification_events WHERE account_id=?").bind(accountId),
    ...[
      "account_badge_awards",
      "account_badge_notifications",
      "account_match_history",
      "legal_consents",
      "privacy_room_accounts",
    ].map((t) => env.APP_DB.prepare(`DELETE FROM ${t} WHERE account_id=?`).bind(accountId)),
    env.APP_DB.prepare("UPDATE privacy_room_players SET avatar_key=NULL WHERE account_id=?").bind(
      accountId,
    ),
    env.APP_DB.prepare("DELETE FROM privacy_avatar_uploads WHERE account_id=?").bind(accountId),
    env.APP_DB.prepare("DELETE FROM feedback_history WHERE admin_id=?").bind(accountId),
    env.APP_DB.prepare("DELETE FROM session WHERE userId=?").bind(accountId),
    env.APP_DB.prepare("DELETE FROM account WHERE userId=?").bind(accountId),
    ...deleteAccountChatStatements(env.APP_DB, accountId),
    env.APP_DB.prepare("DELETE FROM user WHERE id=?").bind(accountId),
  ]);
}
