/** 同日の認証済み操作は同じ最新値とし、ポーリングからは呼びません。 */
export function accountUsageStatement(db: D1Database, accountId: string, atMs: number) {
  const day = new Date(atMs + 9 * 3600000).toISOString().slice(0, 10);
  return db
    .prepare(`INSERT INTO account_usage(account_id,last_used_day)
    SELECT ?,? FROM user WHERE id=?
      AND ? >= (SELECT collected_from_ms FROM analytics_foundation_state WHERE id=1)
      AND NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE id=?)
      AND NOT EXISTS(SELECT 1 FROM guest_account_merges WHERE guest_id=?)
    ON CONFLICT(account_id) DO UPDATE SET last_used_day=excluded.last_used_day
      WHERE last_used_day IS NULL OR last_used_day<excluded.last_used_day`)
    .bind(accountId, day, accountId, atMs, accountId, accountId);
}

export async function recordAccountUsage(db: D1Database, accountId: string, atMs = Date.now()) {
  try {
    await accountUsageStatement(db, accountId, atMs).run();
  } catch {
    // 計測障害で操作を止めず、個人情報を含む例外をログへ出しません。
    console.warn("Account usage save failed");
  }
}
