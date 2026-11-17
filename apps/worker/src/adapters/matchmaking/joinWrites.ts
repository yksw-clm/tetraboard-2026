import type { Wait } from "@tetraboard/context-matchmaking";
import type { ratedMatchmakingPolicy } from "./ratedMatchmaking";
import { noPendingRatedMatch } from "./previousMatch";
export async function joinWait(
  db: D1Database,
  policy: ReturnType<typeof ratedMatchmakingPolicy> | undefined,
  wait: Wait,
  key: string,
  retiredKey: string,
) {
  const results = await db.batch<{
    rating_after: number;
    sigma_after?: number;
    rated_games: number;
  }>([
    db
      .prepare(
        "DELETE FROM tournament_wait_reservations WHERE account_id=? AND lease_until_ms<=? AND match_operation_id IS NULL",
      )
      .bind(wait.accountId, Date.now()),
    db
      .prepare(
        "DELETE FROM matchmaking_wait_reservations WHERE account_id=? AND match_operation_id IS NULL AND (lease_until_ms<=? OR queue_key=?)",
      )
      .bind(wait.accountId, Date.now(), retiredKey),
    db
      .prepare(
        `INSERT INTO matchmaking_wait_reservations(account_id,queue_key,operation_id,lease_until_ms)
            SELECT ?,?,?,?${policy ? ` WHERE ${noPendingRatedMatch}` : ""}`,
      )
      .bind(
        wait.accountId,
        key,
        wait.operationId,
        wait.expiresAtMs,
        ...(policy ? [wait.accountId] : []),
      ),
    ...(policy ? [policy.store.latest(db, wait.accountId)] : []),
  ]);
  return {
    inserted: !!results.at(policy ? -2 : -1)?.meta.changes,
    latest: policy ? results.at(-1)?.results[0] : undefined,
  };
}
