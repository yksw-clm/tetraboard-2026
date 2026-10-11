import type { AuthEnv } from "../accounts/auth";
export async function reserveAvatarUpload(env: AuthEnv, accountId: string, key: string) {
  const result = await env.APP_DB.batch([
    env.APP_DB.prepare(
      "INSERT INTO privacy_avatar_uploads SELECT ?,id,? FROM user WHERE id=? AND NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE id=user.id)",
    ).bind(key, Date.now(), accountId),
    env.APP_DB.prepare(
      "INSERT OR IGNORE INTO avatar_deletions SELECT ? WHERE EXISTS(SELECT 1 FROM privacy_avatar_uploads WHERE key=?)",
    ).bind(key, key),
  ]);
  return result[0].meta.changes === 1;
}
export async function finishAvatarUpload(env: AuthEnv, accountId: string, key: string) {
  await env.APP_DB.batch([
    env.APP_DB.prepare(
      "INSERT OR IGNORE INTO deletion_images SELECT ?,? WHERE EXISTS(SELECT 1 FROM deleted_accounts WHERE id=?)",
    ).bind(accountId, key, accountId),
    env.APP_DB.prepare("UPDATE deleted_accounts SET completed_at_ms=NULL WHERE id=?").bind(
      accountId,
    ),
    env.APP_DB.prepare("DELETE FROM privacy_avatar_uploads WHERE key=?").bind(key),
  ]);
}
