import { recoverTournaments as recover } from "@tetraboard/context-tournament";
export function recoverTournaments(env: Env) {
  return recover({
    async expireWaiting() {
      await env.APP_DB.prepare(
        "DELETE FROM tournament_wait_reservations WHERE lease_until_ms<=? AND match_operation_id IS NULL",
      )
        .bind(Date.now())
        .run();
    },
    async pending() {
      const rows = await env.APP_DB.prepare(
        "SELECT key FROM tournaments WHERE published=1 AND finalized_at_ms IS NULL ORDER BY public_id LIMIT 100",
      ).all<{ key: string }>();
      return rows.results;
    },
    refresh: (key) => env.TOURNAMENT_COORDINATOR.getByName(key).refresh(key),
  });
}
