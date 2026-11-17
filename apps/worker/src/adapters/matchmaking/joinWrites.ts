import { matchmakingWaitFence, prepareMatchmakingWaitFence } from "../../flows/accountSeats/fences";
import type { Wait, LatestQueueRating } from "@tetraboard/context-matchmaking";
import type { ratedMatchmakingPolicy } from "./ratedMatchmaking";
import { noPendingRatedMatch } from "./previousMatch";
type JoinRead = LatestQueueRating & { code?: string | null; pending?: number };

export async function joinWait(
  db: D1Database,
  policy: ReturnType<typeof ratedMatchmakingPolicy> | undefined,
  wait: Wait,
  key: string,
  retiredKey: string,
) {
  const fence = matchmakingWaitFence(wait.accountId);
  const pending = policy ? noPendingRatedMatch(wait.accountId) : undefined;
  const results = await db.batch<JoinRead>([
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
            SELECT ?,?,?,? WHERE ${fence.sql}${pending ? ` AND ${pending.sql}` : ""}`,
      )
      .bind(
        wait.accountId,
        key,
        wait.operationId,
        wait.expiresAtMs,
        ...fence.values,
        ...(pending?.values ?? []),
      ),
    prepareMatchmakingWaitFence(db, wait.accountId),
    ...(policy && pending
      ? [
          db.prepare(`SELECT NOT (${pending.sql}) AS pending`).bind(...pending.values),
          policy.store.latest(db, wait.accountId),
        ]
      : []),
  ]);
  const inserted = !!results[2].meta.changes;
  if (!inserted) {
    const reason = results[3].results[0]?.code;
    if (reason || !policy || !results[4].results[0]?.pending)
      throw new Error(reason ?? "account_busy");
  }
  return {
    inserted,
    latest: policy ? results.at(-1)?.results[0] : undefined,
  };
}
