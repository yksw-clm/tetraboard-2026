export const retiredName = "退会したプレイヤー";
export async function isDeleted(db: D1Database, id: string) {
  return Boolean(await db.prepare("SELECT id FROM deleted_accounts WHERE id = ?").bind(id).first());
}
export async function redactParticipants<
  T extends {
    id?: string;
    participants: { id?: string; kind: string; name: string; accountId?: string | null }[];
  },
>(db: D1Database, record: T): Promise<T> {
  const ids = record.participants.flatMap((p) =>
    p.kind === "human" && p.accountId ? [p.accountId] : [],
  );
  const retiredClaims = record.id
    ? await db
        .prepare(
          "SELECT player_id FROM match_participant_accounts WHERE match_id=? AND state='retired'",
        )
        .bind(record.id)
        .all<{ player_id: string }>()
    : { results: [] };
  const retiredPlayers = new Set(retiredClaims.results.map((row) => row.player_id));
  const rows = ids.length
    ? await db
        .prepare(`SELECT id FROM deleted_accounts WHERE id IN (${ids.map(() => "?").join(",")})`)
        .bind(...ids)
        .all<{ id: string }>()
    : { results: [] };
  const deleted = new Set(rows.results.map((r) => r.id));
  return redactRetiredParticipants(record, retiredPlayers, deleted);
}

export function redactRetiredParticipants<
  T extends {
    participants: { id?: string; name: string; accountId?: string | null }[];
  },
>(record: T, retiredPlayers: ReadonlySet<string>, deleted: ReadonlySet<string>): T {
  if (!deleted.size && !retiredPlayers.size) return record;
  return {
    ...record,
    participants: record.participants.map((p) =>
      (p.accountId && deleted.has(p.accountId)) || (p.id && retiredPlayers.has(p.id))
        ? { ...p, accountId: null, name: retiredName, retired: true }
        : p,
    ),
  };
}
