export async function ensureGuestUsername(db: D1Database, accountId: string): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const username = `guest_${crypto.randomUUID().replaceAll("-", "").slice(0, 14)}`;
    try {
      // 同時取得でも先に確定したIDを保ち、登録者を含む一意制約で衝突を防ぎます。
      const row = await db
        .prepare(`UPDATE user SET username=COALESCE(username,?)
        WHERE id=? AND isAnonymous=1 AND profileCompleted=1
        AND NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE id=user.id)
        AND NOT EXISTS(SELECT 1 FROM guest_account_merges WHERE guest_id=user.id)
        RETURNING username`)
        .bind(username, accountId)
        .first<{ username: string }>();
      if (!row) throw new Error("Guest username unavailable");
      return row.username;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !/UNIQUE constraint/.test(error.message) ||
        !/user\.username|user_username_normalized_idx/.test(error.message)
      )
        throw error;
    }
  }
  throw new Error("Guest username allocation failed");
}
