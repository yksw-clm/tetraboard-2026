import { z } from "zod";
import { analyticsRetentionMs } from "@tetraboard/protocol/privacy";
import { gameIdSchema } from "@tetraboard/protocol";

export const matchmakingEventSchema = z
  .object({
    operationId: z.string().min(1).max(200),
    accountId: z.string().min(1).max(200),
    matchId: z.string().min(1).max(200).nullable(),
    game: gameIdSchema,
    stage: z.enum(["accepted", "matched", "started", "cancelled", "failed", "retry"]),
    reason: z
      .enum([
        "cpu_capacity",
        "ai_unavailable",
        "connection_timeout",
        "lease_expired",
        "invalidated",
        "cancelled",
        "unavailable",
      ])
      .nullable(),
    atMs: z.number().int().nonnegative(),
    waitingMs: z.number().int().nonnegative().nullable(),
    humans: z.number().int().min(1).max(4).nullable(),
    rated: z.boolean(),
    isTest: z.boolean().optional(),
  })
  .strict();
export type MatchmakingEvent = z.infer<typeof matchmakingEventSchema>;
type Pending = { event: MatchmakingEvent; retryAtMs: number };
const prefix = "matchmaking-analytics-pending:";
const keyOf = (event: MatchmakingEvent) =>
  prefix +
  JSON.stringify([
    event.operationId,
    event.accountId,
    ["cancelled", "failed"].includes(event.stage) ? "ended" : event.stage,
    event.stage === "retry" ? event.matchId : null,
  ]);

/** 呼び出し側の状態保存と同じtransactionSync内で保存します。任意データは受け取りません。 */
export function enqueueMatchmakingEvent(storage: DurableObjectStorage, input: MatchmakingEvent) {
  const event = matchmakingEventSchema.parse(input),
    key = keyOf(event);
  if (!storage.kv.get(key)) storage.kv.put(key, { event, retryAtMs: event.atMs } satisfies Pending);
}
export function purgeMatchmakingEvents(storage: DurableObjectStorage, accountId: string) {
  for (const [key, job] of storage.kv.list<Pending>({ prefix }))
    if (job.event.accountId === accountId) storage.kv.delete(key);
}

/** DB障害を対局へ伝播させず、保存待ちと次のAlarm期限を保持します。 */
export async function flushMatchmakingEvents(
  storage: DurableObjectStorage,
  db: D1Database,
  now = Date.now(),
): Promise<number | null> {
  const jobs = [...storage.kv.list<Pending>({ prefix })].slice(0, 32);
  for (const [key, job] of jobs) {
    if (job.event.atMs <= now - analyticsRetentionMs) {
      storage.kv.delete(key);
      continue;
    }
    if (job.retryAtMs > now) continue;
    const e = job.event;
    try {
      await matchmakingEventStatement(db, e).run();
      storage.kv.delete(key);
    } catch {
      storage.kv.put(key, { ...job, retryAtMs: now + 5000 });
      console.warn("Matchmaking analytics save will be retried");
      break;
    }
  }
  const pending = [...storage.kv.list<Pending>({ prefix })];
  return pending.length ? Math.min(...pending.map(([, job]) => job.retryAtMs)) : null;
}

export function matchmakingEventStatement(db: D1Database, e: MatchmakingEvent) {
  return db
    .prepare(`INSERT INTO analytics_matchmaking_events
 (id,operation_id,account_id,match_id,game,stage,reason,at_ms,waiting_ms,humans,rated,is_test)
 SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE id=?)
 ON CONFLICT(id) DO NOTHING`)
    .bind(
      keyOf(e).slice(prefix.length),
      e.operationId,
      e.accountId,
      e.matchId,
      e.game,
      e.stage,
      e.reason,
      e.atMs,
      e.waitingMs,
      e.humans,
      Number(e.rated),
      Number(e.isTest ?? false),
      e.accountId,
    );
}
