import type {
  PublishedTournamentPagesReader,
  TournamentReader,
  TournamentRow,
  PublicCounts,
  ScoreRow,
} from "@tetraboard/context-tournament";
import type { GameScope } from "@tetraboard/protocol/games";
export class D1TournamentReader implements TournamentReader, PublishedTournamentPagesReader {
  constructor(private db: D1Database) {}
  read(key: string) {
    return this.db
      .prepare("SELECT * FROM tournaments WHERE key=?")
      .bind(key)
      .first<TournamentRow>();
  }
  public(id: number) {
    return this.db
      .prepare("SELECT * FROM tournaments WHERE public_id=? AND published=1")
      .bind(id)
      .first<TournamentRow>();
  }
  async entryCount(key: string) {
    return (await this.db
      .prepare("SELECT COUNT(*) AS n FROM tournament_entries WHERE tournament_key=? AND deleted=0")
      .bind(key)
      .first<{ n: number }>())!.n;
  }
  async counts(key: string) {
    const counts = await this.db
      .prepare(`SELECT
    SUM(phase='playing') AS playing, SUM(phase IN ('reserved','saving')) AS pending,
    SUM(phase='saved') AS completed FROM tournament_matches WHERE tournament_key=?`)
      .bind(key)
      .first<{ playing: number | null; pending: number | null; completed: number | null }>();
    return counts;
  }
  async waitingCount(key: string, now: number) {
    const waiting = await this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM tournament_wait_reservations w WHERE tournament_key=? AND lease_until_ms>? AND match_operation_id IS NULL
        AND NOT EXISTS(SELECT 1 FROM tournament_match_players p JOIN tournament_matches m ON m.id=p.match_id
          WHERE p.account_id=w.account_id AND m.tournament_key=w.tournament_key AND m.phase='reserved')`,
      )
      .bind(key, now)
      .first<{ n: number }>();
    return waiting!.n;
  }
  async lobbyRows(game: GameScope, now: number, cutoff: number) {
    const rows = await this.db
      .prepare(`SELECT t.*,
    (SELECT COUNT(*) FROM tournament_entries e WHERE e.tournament_key=t.key AND e.deleted=0) AS entryCount,
    (SELECT COUNT(*) FROM tournament_wait_reservations w WHERE w.tournament_key=t.key AND w.lease_until_ms>?
      AND w.match_operation_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM tournament_match_players p JOIN tournament_matches m ON m.id=p.match_id
        WHERE p.account_id=w.account_id AND m.tournament_key=w.tournament_key AND m.phase='reserved')) AS waitingCount,
    (SELECT COUNT(*) FROM tournament_matches m WHERE m.tournament_key=t.key AND m.phase='playing') AS playingCount,
    (SELECT COUNT(*) FROM tournament_matches m WHERE m.tournament_key=t.key AND m.phase IN ('reserved','saving')) AS pendingCount,
    (SELECT COUNT(*) FROM tournament_matches m WHERE m.tournament_key=t.key AND m.phase='saved') AS completedCount
    FROM tournaments t WHERE t.published=1 AND t.ends_at_ms>? AND (?='all' OR t.game=?)
    ORDER BY t.starts_at_ms,t.public_id`)
      .bind(now, cutoff, game, game)
      .all<TournamentRow & PublicCounts>();
    return rows.results;
  }
  async listRows(game: GameScope, cursor: string | undefined) {
    const [at, id] = cursor?.split(":") ?? [];
    const result = await this.db
      .prepare(`SELECT t.*,
      (SELECT COUNT(*) FROM tournament_entries e WHERE e.tournament_key=t.key AND e.deleted=0) AS entryCount
    FROM tournaments t WHERE t.published=1 AND (?='all' OR t.game=?)
    ${cursor ? "AND (t.starts_at_ms<? OR (t.starts_at_ms=? AND t.public_id<?))" : ""}
    ORDER BY t.starts_at_ms DESC,t.public_id DESC LIMIT 21`)
      .bind(game, game, ...(cursor ? [Number(at), Number(at), Number(id)] : []))
      .all<TournamentRow & { entryCount: number }>();
    return result.results;
  }
  async publicPageRows() {
    const rows = await this.db
      .prepare(`SELECT * FROM tournaments
        WHERE published=1 AND public_id IS NOT NULL
        ORDER BY starts_at_ms DESC,public_id DESC`)
      .all<TournamentRow>();
    return rows.results;
  }
  async winnerRows(finalized: string[]) {
    const scores = await this.db
      .prepare(`SELECT e.tournament_key AS tournamentKey,
      e.id AS entryId,e.account_id AS accountId,e.deleted,u.name,u.username,u.publicProfileId,u.avatarKey,u.avatarPresetId,u.isAnonymous,
      s.points_units AS pointsUnits,s.games,s.first,s.second,s.third,s.fourth,s.knockouts,s.rank_sum AS rankSum,s.final_rank AS finalRank
      FROM tournament_entries e JOIN tournament_scores s ON s.entry_id=e.id AND s.tournament_key=e.tournament_key
      LEFT JOIN user u ON u.id=e.account_id AND e.deleted=0 AND NOT EXISTS(SELECT 1 FROM deleted_accounts d WHERE d.id=u.id)
      WHERE e.tournament_key IN (${finalized.map(() => "?").join(",")}) AND s.final_rank=1 AND s.games>0
      ORDER BY e.tournament_key,e.id`)
      .bind(...finalized)
      .all<ScoreRow & { tournamentKey: string }>();
    return scores.results;
  }
  async scoreRows(row: TournamentRow) {
    const values = await this.db
      .prepare(`SELECT e.id AS entryId,e.account_id AS accountId,e.deleted,u.name,u.username,u.publicProfileId,u.avatarKey,u.avatarPresetId,u.isAnonymous,
    COALESCE(s.points_units,0) AS pointsUnits,COALESCE(s.games,0) AS games,
    COALESCE(s.first,0) AS first,COALESCE(s.second,0) AS second,COALESCE(s.third,0) AS third,COALESCE(s.fourth,0) AS fourth,
    COALESCE(s.knockouts,0) AS knockouts,COALESCE(s.rank_sum,0) AS rankSum,s.final_rank AS finalRank
    FROM tournament_entries e LEFT JOIN tournament_scores s ON s.entry_id=e.id
    LEFT JOIN user u ON u.id=e.account_id AND e.deleted=0 AND NOT EXISTS(SELECT 1 FROM deleted_accounts d WHERE d.id=u.id)
    WHERE e.tournament_key=? AND (e.deleted=0 OR (? IS NOT NULL AND s.final_rank IS NOT NULL))`)
      .bind(row.key, row.finalized_at_ms)
      .all<ScoreRow>();
    return values.results;
  }
  async adminRows(offset: number) {
    const rows = await this.db
      .prepare("SELECT * FROM tournaments ORDER BY starts_at_ms DESC,key DESC LIMIT 51 OFFSET ?")
      .bind(offset)
      .all<TournamentRow>();
    return rows.results;
  }
}
