import type { StoredProfile } from "@tetraboard/context-account";
export async function identifyGuest(
  db: D1Database,
  hash: string,
  now: number,
  guestLifetimeMs: number,
): Promise<StoredProfile | null> {
  const condition = `s.token_hash=? AND s.expires_at_ms>? AND s.registered_at_ms IS NULL AND u.isAnonymous=1
    AND NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE id=u.id)
    AND NOT EXISTS(SELECT 1 FROM guest_account_merges WHERE guest_id=u.id)`;
  const results = await db.batch<StoredProfile>([
    db
      .prepare(`UPDATE guest_sessions SET expires_at_ms=? WHERE token_hash IN (
      SELECT s.token_hash FROM guest_sessions s JOIN user u ON u.id=s.account_id WHERE ${condition})`)
      .bind(now + guestLifetimeMs, hash, now),
    db
      .prepare(`SELECT u.* FROM guest_sessions s JOIN user u ON u.id=s.account_id
    WHERE ${condition}`)
      .bind(hash, now),
  ]);
  return results[1].results[0] ?? null;
}
