import type { TournamentRow } from "@tetraboard/context-tournament";

export function readOverdueLobbyTournaments(db: D1Database, now: number) {
  return db
    .prepare(
      "SELECT key FROM tournaments WHERE published=1 AND finalized_at_ms IS NULL AND ends_at_ms<=? ORDER BY public_id LIMIT 20",
    )
    .bind(now)
    .all<{ key: string }>();
}

export function readLobbyTournament(db: D1Database, now: number) {
  return db
    .prepare(`SELECT * FROM tournaments WHERE published=1 ORDER BY
    CASE WHEN finalized_at_ms IS NULL AND starts_at_ms<=? AND ends_at_ms>? THEN 0
      WHEN finalized_at_ms IS NULL AND ends_at_ms<=? THEN 1 WHEN starts_at_ms>? THEN 2 ELSE 3 END,
    CASE WHEN starts_at_ms>? THEN starts_at_ms END ASC,public_id DESC LIMIT 1`)
    .bind(now, now, now, now, now)
    .first<TournamentRow>();
}

export function readNextTournament(db: D1Database, row: TournamentRow) {
  return db
    .prepare(
      "SELECT * FROM tournaments WHERE published=1 AND public_id>? AND starts_at_ms>=? ORDER BY public_id LIMIT 1",
    )
    .bind(row.public_id, row.ends_at_ms)
    .first<TournamentRow>();
}

export function readTournamentEntries(db: D1Database, key: string, search: string, offset: number) {
  const query = `FROM tournament_entries e JOIN user u ON u.id=e.account_id WHERE e.tournament_key=? AND e.deleted=0
    AND NOT EXISTS(SELECT 1 FROM deleted_accounts d WHERE d.id=u.id)
    AND (?='' OR instr(lower(u.name),lower(?))>0 OR instr(lower(u.username),lower(?))>0)`;
  return Promise.all([
    db
      .prepare(
        `SELECT e.id,e.account_id,e.entered_at_ms,u.name,u.username,u.avatarKey,u.avatarPresetId,u.isAnonymous ${query} ORDER BY e.entered_at_ms,e.id LIMIT 51 OFFSET ?`,
      )
      .bind(key, search, search, search, offset)
      .all<{
        id: string;
        account_id: string;
        entered_at_ms: number;
        name: string;
        username: string | null;
        isAnonymous: number | null;
        avatarKey: string | null;
        avatarPresetId: string | null;
      }>(),
    db
      .prepare(`SELECT COUNT(*) AS n ${query}`)
      .bind(key, search, search, search)
      .first<{ n: number }>(),
  ]);
}

export function readEnteredActiveTournaments(db: D1Database, accountId: string) {
  return db
    .prepare(`SELECT DISTINCT e.tournament_key
        FROM tournament_entries e JOIN tournaments t ON t.key=e.tournament_key
        WHERE e.account_id=? AND t.published=1 AND t.finalized_at_ms IS NULL`)
    .bind(accountId)
    .all<{ tournament_key: string }>();
}
