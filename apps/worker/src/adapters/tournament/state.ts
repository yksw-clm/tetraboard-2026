import type { PendingTournamentState } from "@tetraboard/context-tournament";
export async function writeTournamentState(db: D1Database, job: PendingTournamentState) {
  const { reservation, phase } = job;
  await db
    .prepare(`UPDATE tournament_matches SET phase=?,
      started_at_ms=COALESCE(started_at_ms,?),
      finished_at_ms=CASE WHEN ? IN ('saving','aborted') THEN COALESCE(finished_at_ms,?) ELSE finished_at_ms END,
      updated_at_ms=?
      WHERE id=? AND tournament_key=? AND room_id=? AND instance_id=?
        AND (phase IN ('reserved','playing') OR (phase='saving' AND ? IN ('saving','aborted')))`)
    .bind(
      phase,
      reservation.startedAtMs ?? null,
      phase,
      Date.now(),
      Date.now(),
      reservation.context.matchId,
      reservation.context.tournamentKey,
      reservation.roomId,
      reservation.instanceId,
      phase,
    )
    .run();
}
