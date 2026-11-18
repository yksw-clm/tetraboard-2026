import type { AuthEnv } from "../../accounts/auth";
import { digest } from "../../crypto";
import { feedbackAccountHash } from "./feedbackAccountHash";

export async function requestDeletion(env: AuthEnv, id: string, receipt: string) {
  const tokenHash = await digest(receipt);
  const reporterHash = await feedbackAccountHash(env, id);
  const results = await env.APP_DB.batch([
    env.APP_DB.prepare(`INSERT INTO deleted_accounts(id,requested_at_ms,receipt_hash,avatar_key,provider,revocation_token)
  SELECT u.id,?,?,u.avatarKey,a.providerId,a.accessToken FROM user u LEFT JOIN account a ON a.userId=u.id
  WHERE u.id=? AND NOT EXISTS(SELECT 1 FROM account_room_seats s WHERE s.account_id=u.id)
  AND NOT EXISTS(SELECT 1 FROM deleted_accounts d WHERE d.id=u.id) LIMIT 1 RETURNING id`).bind(
      Date.now(),
      tokenHash,
      id,
    ),
    env.APP_DB.prepare(
      "UPDATE feedback SET deleted=1 WHERE reporter_hash=? AND EXISTS(SELECT 1 FROM deleted_accounts WHERE id=? AND receipt_hash=?)",
    ).bind(reporterHash, id, tokenHash),
    // 旧実装の席・保存待ちも確認するため、既存の部屋を対象に含めます。
    env.APP_DB.prepare(
      `INSERT OR IGNORE INTO deletion_rooms SELECT ?,room_id FROM room_index WHERE EXISTS(SELECT 1 FROM deleted_accounts WHERE id=? AND receipt_hash=?)`,
    ).bind(id, id, tokenHash),
    env.APP_DB.prepare(
      `INSERT OR IGNORE INTO deletion_rooms SELECT account_id,room_id FROM privacy_room_accounts WHERE account_id=? AND EXISTS(SELECT 1 FROM deleted_accounts WHERE id=? AND receipt_hash=?)`,
    ).bind(id, id, tokenHash),
    ...[
      "deletion_flows",
      "deletion_challenges",
      "tournament_wait_reservations",
      "matchmaking_wait_reservations",
      "elo_rating_changes",
      "skill_rating_changes",
      "elo_rating_pending",
      "skill_rating_pending",
    ].map((table) =>
      env.APP_DB.prepare(
        `DELETE FROM ${table} WHERE account_id=? AND EXISTS(SELECT 1 FROM deleted_accounts WHERE id=? AND receipt_hash=?)`,
      ).bind(id, id, tokenHash),
    ),
    env.APP_DB.prepare(
      "UPDATE tournament_entries SET deleted=1 WHERE account_id=? AND EXISTS(SELECT 1 FROM deleted_accounts WHERE id=? AND receipt_hash=?)",
    ).bind(id, id, tokenHash),
  ]);
  return results[0].results.length === 1;
}
