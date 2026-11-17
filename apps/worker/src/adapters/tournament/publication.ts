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
