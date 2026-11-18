export async function isDeleted(db: D1Database, id: string) {
  return Boolean(await db.prepare("SELECT id FROM deleted_accounts WHERE id = ?").bind(id).first());
}

export async function readDeletedAccounts(db: D1Database, ids: string[]) {
  const rows = await db
    .prepare(`SELECT id FROM deleted_accounts WHERE id IN (${ids.map(() => "?").join(",")})`)
    .bind(...ids)
    .all<{ id: string }>();
  return new Set(rows.results.map((r) => r.id));
}
