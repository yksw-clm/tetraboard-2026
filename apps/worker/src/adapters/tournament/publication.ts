import type {
  TournamentPublication,
  TournamentRoomContext,
  TournamentMatchRecord,
  TournamentPoints,
} from "@tetraboard/context-tournament";
import type { TournamentSettings } from "@tetraboard/protocol";
export class D1TournamentPublication implements TournamentPublication<D1PreparedStatement> {
  constructor(private db: D1Database) {}
  points(
    context: TournamentRoomContext,
    record: TournamentMatchRecord,
    game: TournamentSettings["game"],
    points: TournamentPoints,
  ) {
    return this.db
      .prepare(`INSERT INTO tournament_point_events(match_id,entry_id,rank,knockouts,points_units)
      SELECT m.id,p.entry_id,?,?,? FROM tournament_matches m
      JOIN tournament_match_players p ON p.match_id=m.id
      JOIN tournaments t ON t.key=m.tournament_key
      WHERE m.id=? AND m.tournament_key=? AND m.room_id=? AND m.instance_id=? AND p.player_id=?
        AND m.phase IN ('reserved','playing','saving','saved') AND t.finalized_at_ms IS NULL
        AND EXISTS(SELECT 1 FROM matches WHERE id=m.id AND game=?)
      ON CONFLICT(match_id,entry_id) DO NOTHING`)
      .bind(
        points.rank,
        points.knockouts,
        points.units,
        context.matchId,
        context.tournamentKey,
        record.roomId,
        record.instanceId,
        points.playerId,
        game,
      );
  }
  scores(context: TournamentRoomContext, points: TournamentPoints) {
    return this.db
      .prepare(`INSERT INTO tournament_scores(entry_id,tournament_key,points_units,games,first,second,third,fourth,knockouts,rank_sum)
      SELECT p.entry_id,m.tournament_key,SUM(e.points_units),COUNT(*),
        SUM(e.rank=1),SUM(e.rank=2),SUM(e.rank=3),SUM(e.rank=4),SUM(e.knockouts),SUM(e.rank)
      FROM tournament_matches m
      JOIN tournament_match_players p ON p.match_id=m.id
      JOIN tournament_point_events e ON e.entry_id=p.entry_id
      JOIN tournaments t ON t.key=m.tournament_key
      WHERE m.id=? AND m.tournament_key=? AND p.player_id=?
        AND m.phase IN ('reserved','playing','saving','saved') AND t.finalized_at_ms IS NULL
      GROUP BY p.entry_id,m.tournament_key
      ON CONFLICT(entry_id) DO UPDATE SET
        points_units=excluded.points_units,games=excluded.games,
        first=excluded.first,second=excluded.second,third=excluded.third,fourth=excluded.fourth,
        knockouts=excluded.knockouts,rank_sum=excluded.rank_sum`)
      .bind(context.matchId, context.tournamentKey, points.playerId);
  }
  saved(context: TournamentRoomContext, record: TournamentMatchRecord, now: number) {
    return this.db
      .prepare(
        `UPDATE tournament_matches SET phase='saved',started_at_ms=?,finished_at_ms=?,updated_at_ms=? WHERE id=? AND tournament_key=? AND room_id=? AND instance_id=? AND phase IN ('reserved','playing','saving') AND (SELECT COUNT(*) FROM tournament_point_events WHERE match_id=?)=4`,
      )
      .bind(
        record.startedAtMs,
        record.endedAtMs,
        now,
        context.matchId,
        context.tournamentKey,
        record.roomId,
        record.instanceId,
        context.matchId,
      );
  }
}
