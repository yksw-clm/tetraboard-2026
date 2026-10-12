export const retiredName = "退会したプレイヤー";
export async function isDeleted(db: D1Database, id: string) {
  return Boolean(await db.prepare("SELECT id FROM deleted_accounts WHERE id = ?").bind(id).first());
}
export async function redactParticipants<
  T extends { participants: { kind: string; name: string; accountId?: string | null }[] },
>(db: D1Database, record: T): Promise<T> {
  const ids = record.participants.flatMap((p) =>
    p.kind === "human" && p.accountId ? [p.accountId] : [],
  );
  if (!ids.length) return record;
  const rows = await db
    .prepare(`SELECT id FROM deleted_accounts WHERE id IN (${ids.map(() => "?").join(",")})`)
    .bind(...ids)
    .all<{ id: string }>();
  const deleted = new Set(rows.results.map((r) => r.id));
  if (!deleted.size) return record;
  return {
    ...record,
    participants: record.participants.map((p) =>
      p.accountId && deleted.has(p.accountId)
        ? { ...p, accountId: null, name: retiredName, retired: true }
        : p,
    ),
  };
}
