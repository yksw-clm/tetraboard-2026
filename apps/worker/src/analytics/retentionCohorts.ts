import {
  gameScopeIds,
  retentionAnalyticsSchema,
  type AdminAnalyticsQuery,
} from "@tetraboard/protocol";
import { analyticsRetentionMs } from "@tetraboard/protocol/privacy";
import { adminAccountIds, type AdminEnv } from "../admin/auth";
const week = 168 * 3600000;
const day = (at: number) => new Date(at + 32400000).toISOString().slice(0, 10);
const counters = [
  "enrolled",
  "eligible",
  "retained",
  "retained_next_day",
  "observing",
  "unknown",
  "reached1",
  "reached2",
  "reached3",
  "reached4",
  "reached5",
] as const;
const keys = "day,metric,game,kind,internal";
const ratings = [
  ["shogi", "shogi"],
  ["reversi", "reversi"],
  ["four-shogi", "four_shogi"],
  ["four-reversi", "four_reversi"],
] as const;
type Candidate = {
  id: string;
  game: string;
  ended_at_ms: number;
  completion_is_guest: number | null;
  is_test: number | null;
};
function nextStart(extra = "") {
  return `EXISTS(SELECT 1 FROM analytics_participants p JOIN analytics_matches m ON m.id=p.match_id
 WHERE p.origin_account_id=s.account_id AND (s.game='all' OR m.game=s.game) AND m.id!=s.origin_match_id
 AND m.started_at_ms>=s.origin_at_ms AND m.started_at_ms<=s.until_ms ${extra})`;
}
function refreshReturns(db: D1Database, account: string, now: number) {
  return db
    .prepare(`UPDATE analytics_retention_subjects AS s SET
 eligible=CASE WHEN kind!='unknown' AND until_ms<=? THEN 1 ELSE 0 END,
 observing=CASE WHEN kind!='unknown' AND until_ms>? THEN 1 ELSE 0 END,
 unknown=(kind='unknown'),retained=${nextStart()},retained_next_day=${nextStart("AND strftime('%Y-%m-%d',m.started_at_ms/1000+32400,'unixepoch')>s.day")},
 evaluated_at_ms=?,next_check_at_ms=CASE WHEN until_ms>? THEN until_ms ELSE NULL END
 WHERE account_id=? AND metric IN('return','post-placement') AND expires_at_ms>?`)
    .bind(now, now, now, now, account, now);
}
function originStatement(
  db: D1Database,
  account: string,
  metric: string,
  game: string,
  origin: Candidate,
  kind: string,
  internal: boolean,
  window: number,
  now: number,
) {
  return db
    .prepare(`INSERT INTO analytics_retention_subjects(account_id,metric,game,origin_match_id,origin_at_ms,day,kind,is_internal,until_ms,expires_at_ms)
 SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM user WHERE id=?) AND NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE id=?)
 ON CONFLICT(account_id,metric,game) DO UPDATE SET
 kind=CASE WHEN origin_match_id=excluded.origin_match_id AND kind!='unknown' THEN kind ELSE excluded.kind END,
 is_internal=CASE WHEN origin_match_id=excluded.origin_match_id AND kind!='unknown' THEN is_internal ELSE excluded.is_internal END,
 origin_match_id=excluded.origin_match_id,origin_at_ms=excluded.origin_at_ms,day=excluded.day,until_ms=excluded.until_ms,expires_at_ms=excluded.expires_at_ms
 WHERE analytics_retention_subjects.expires_at_ms>?`)
    .bind(
      account,
      metric,
      game,
      origin.id,
      origin.ended_at_ms,
      day(origin.ended_at_ms),
      kind,
      Number(internal),
      origin.ended_at_ms + window,
      origin.ended_at_ms + analyticsRetentionMs,
      account,
      account,
      now,
    );
}
export async function aggregateRetention(env: AdminEnv, now = Date.now()) {
  const db = env.APP_DB,
    owners = adminAccountIds(env) ?? [],
    cutoff = now - analyticsRetentionMs;
  const collected = Number(
    await db
      .prepare("SELECT value FROM analytics_metadata WHERE key='retention_collected_from'")
      .first("value"),
  );
  await db
    .prepare(
      `INSERT OR IGNORE INTO analytics_retention_accounts(account_id) SELECT DISTINCT account_id FROM analytics_retention_subjects WHERE next_check_at_ms<=? AND expires_at_ms>? LIMIT 50`,
    )
    .bind(now, now)
    .run();
  const accounts = (
    await db
      .prepare(
        "SELECT account_id,revision FROM analytics_retention_accounts ORDER BY account_id LIMIT 50",
      )
      .all<{ account_id: string; revision: number }>()
  ).results;
  for (const { account_id: account, revision } of accounts) {
    const statements: D1PreparedStatement[] = [];
    const merged = await db
      .prepare("SELECT 1 FROM guest_account_merges WHERE guest_id=?")
      .bind(account)
      .first();
    if (!merged) {
      const firsts = (
        await db
          .prepare(`WITH ranked AS (
    SELECT m.id,s.value AS game,m.ended_at_ms,ROW_NUMBER() OVER(PARTITION BY s.value ORDER BY m.ended_at_ms,m.id) AS pos
    FROM account_match_history h JOIN matches m ON m.id=h.match_id CROSS JOIN json_each(?) s
    WHERE h.account_id=? AND (s.value='all' OR s.value=m.game)
    AND NOT EXISTS(SELECT 1 FROM analytics_participants p WHERE p.match_id=m.id AND p.account_id=h.account_id AND p.origin_account_id IS NOT NULL AND p.origin_account_id!=h.account_id))
    SELECT r.id,r.game,r.ended_at_ms,
      (SELECT completion_is_guest FROM analytics_participants WHERE match_id=r.id AND origin_account_id=? ORDER BY player_id LIMIT 1) AS completion_is_guest,
      (SELECT is_test FROM analytics_participants WHERE match_id=r.id AND origin_account_id=? ORDER BY player_id LIMIT 1) AS is_test
    FROM ranked r WHERE pos=1 AND ended_at_ms>=? AND ended_at_ms>? AND ended_at_ms<=?`)
          .bind(JSON.stringify(gameScopeIds), account, account, account, collected, cutoff, now)
          .all<Candidate>()
      ).results;
      statements.push(
        db
          .prepare(
            `DELETE FROM analytics_retention_subjects WHERE account_id=? AND metric='return' AND expires_at_ms>? AND game NOT IN(SELECT value FROM json_each(?))`,
          )
          .bind(account, now, JSON.stringify(firsts.map((r) => r.game))),
      );
      for (const r of firsts)
        statements.push(
          originStatement(
            db,
            account,
            "return",
            r.game,
            r,
            r.completion_is_guest === null
              ? "unknown"
              : r.completion_is_guest
                ? "guest"
                : "registered",
            Boolean(r.is_test) || owners.includes(account),
            week,
            now,
          ),
        );
      for (const [game, table] of ratings) {
        const rows = (
          await db
            .prepare(
              `SELECT m.id,m.ended_at_ms,r.rated_games FROM ${table}_rating_changes r JOIN matches m ON m.id=r.match_id WHERE r.account_id=? AND r.rated_games<=5 ORDER BY r.rated_games`,
            )
            .bind(account)
            .all<Candidate & { rated_games: number }>()
        ).results;
        for (const [metric, n, window] of [
          ["placement", 1, analyticsRetentionMs],
          ["post-placement", 5, week],
        ] as const) {
          const first = rows.find((r) => r.rated_games === n),
            active =
              first &&
              first.ended_at_ms >= collected &&
              first.ended_at_ms > cutoff &&
              first.ended_at_ms <= now;
          if (!active) {
            statements.push(
              db
                .prepare(
                  "DELETE FROM analytics_retention_subjects WHERE account_id=? AND metric=? AND game=? AND expires_at_ms>?",
                )
                .bind(account, metric, game, now),
            );
            continue;
          }
          const test = await db
            .prepare(
              "SELECT is_test FROM analytics_participants WHERE match_id=? AND origin_account_id=? LIMIT 1",
            )
            .bind(first.id, account)
            .first<number>("is_test");
          const internal = owners.includes(account) || Boolean(test),
            kind = test === null ? "unknown" : "registered";
          statements.push(
            originStatement(db, account, metric, game, first, kind, internal, window, now),
          );
          if (metric === "placement") {
            const until = first.ended_at_ms + analyticsRetentionMs;
            const reached = [1, 2, 3, 4, 5].map((n) =>
              Number(
                rows.some((r) => r.rated_games === n && r.ended_at_ms <= Math.min(until, now)),
              ),
            );
            statements.push(
              db
                .prepare(
                  // 開始記録が先に期限削除されても、起点へ保存済みの区分を使います。
                  `UPDATE analytics_retention_subjects SET eligible=CASE WHEN kind!='unknown' THEN ? ELSE 0 END,observing=CASE WHEN kind!='unknown' THEN ? ELSE 0 END,unknown=(kind='unknown'),${reached.map((_, i) => `reached${i + 1}=CASE WHEN kind!='unknown' THEN ? ELSE 0 END`).join(",")},evaluated_at_ms=?,next_check_at_ms=? WHERE account_id=? AND metric='placement' AND game=?`,
                )
                .bind(
                  Number(now >= until),
                  Number(now < until),
                  ...reached,
                  now,
                  now < until ? until : null,
                  account,
                  game,
                ),
            );
          }
        }
      }
    }
    statements.push(
      refreshReturns(db, account, now),
      db
        .prepare("DELETE FROM analytics_retention_accounts WHERE account_id=? AND revision=?")
        .bind(account, revision),
    );
    await db.batch(statements);
  }
  const dirty = (
    await db
      .prepare(
        "SELECT day,revision FROM analytics_retention_dirty_days d WHERE NOT EXISTS(SELECT 1 FROM analytics_retention_subjects s WHERE s.day=d.day AND s.expires_at_ms<=?) ORDER BY day LIMIT 16",
      )
      .bind(now)
      .all<{ day: string; revision: number }>()
  ).results;
  const publish: D1PreparedStatement[] = [];
  for (const { day: date, revision } of dirty) {
    publish.push(db.prepare("DELETE FROM analytics_retention_daily WHERE day=?").bind(date));
    publish.push(
      db
        .prepare(`INSERT INTO analytics_retention_daily SELECT ${keys},${counters.map((c) => `SUM(${c})`).join(",")} FROM (
   SELECT s.day,s.metric,s.game,s.kind,scope.internal,${counters.map((c) => (c === "retained" || c === "retained_next_day" ? `CASE WHEN s.eligible=1 AND s.unknown=0 THEN s.${c} ELSE 0 END AS ${c}` : `s.${c}`)).join(",")}
   FROM analytics_retention_subjects s CROSS JOIN (SELECT 0 AS internal UNION ALL SELECT 1) scope WHERE day=? AND (scope.internal=1 OR s.is_internal=0)
   UNION ALL SELECT * FROM analytics_retention_archive WHERE day=?) GROUP BY ${keys}`)
        .bind(date, date),
    );
    publish.push(
      db
        .prepare("DELETE FROM analytics_retention_dirty_days WHERE day=? AND revision=?")
        .bind(date, revision),
    );
  }
  publish.push(
    db
      .prepare(`INSERT INTO analytics_metadata(key,value) SELECT 'retention_aggregated_at',? WHERE NOT EXISTS(SELECT 1 FROM analytics_retention_accounts) AND NOT EXISTS(SELECT 1 FROM analytics_retention_dirty_days)
 AND NOT EXISTS(SELECT 1 FROM analytics_retention_subjects WHERE next_check_at_ms<=?) ON CONFLICT(key) DO UPDATE SET value=MAX(value,excluded.value)`)
      .bind(now, now),
  );
  await db.batch(publish);
}
export function retentionArchiveStatements(env: Env, cutoff: number, now: number) {
  const db = env.APP_DB;
  const statements: D1PreparedStatement[] = [];
  // 90日到達の直前に保存された認定結果は、恒久レート記録から最後に確認します。
  for (const [game, table] of ratings)
    statements.push(
      db
        .prepare(
          `UPDATE analytics_retention_subjects AS s SET eligible=(kind!='unknown'),observing=0,evaluated_at_ms=?,${[1, 2, 3, 4, 5].map((n) => `reached${n}=CASE WHEN kind!='unknown' THEN EXISTS(SELECT 1 FROM ${table}_rating_changes r JOIN matches m ON m.id=r.match_id WHERE r.account_id=s.account_id AND r.rated_games=${n} AND m.ended_at_ms<=s.until_ms) ELSE 0 END`).join(",")} WHERE metric='placement' AND game=? AND origin_at_ms<=?`,
        )
        .bind(now, game, cutoff),
    );
  statements.push(
    db
      .prepare(`UPDATE analytics_retention_subjects AS s SET
 retained=MAX(retained,${nextStart()}),retained_next_day=MAX(retained_next_day,${nextStart("AND strftime('%Y-%m-%d',m.started_at_ms/1000+32400,'unixepoch')>s.day")}),
 unknown=MAX(unknown,evaluated_at_ms<until_ms),observing=0 WHERE metric!='placement' AND origin_at_ms<=?`)
      .bind(cutoff),
  );
  statements.push(
    db
      .prepare(`INSERT INTO analytics_retention_archive SELECT s.day,s.metric,s.game,s.kind,scope.internal,
 SUM(enrolled),SUM(CASE WHEN unknown=0 THEN eligible ELSE 0 END),SUM(CASE WHEN unknown=0 THEN retained*eligible ELSE 0 END),SUM(CASE WHEN unknown=0 THEN retained_next_day*eligible ELSE 0 END),0,SUM(unknown),${[1, 2, 3, 4, 5].map((n) => `SUM(reached${n})`).join(",")}
 FROM analytics_retention_subjects s CROSS JOIN (SELECT 0 AS internal UNION ALL SELECT 1) scope WHERE origin_at_ms<=? AND (scope.internal=1 OR s.is_internal=0) GROUP BY 1,2,3,4,5
 ON CONFLICT(${keys}) DO UPDATE SET ${counters.map((c) => `${c}=${c}+excluded.${c}`).join(",")}`)
      .bind(cutoff),
    db.prepare("DELETE FROM analytics_retention_subjects WHERE origin_at_ms<=?").bind(cutoff),
  );
  return statements;
}
export async function readRetention(env: Env, q: AdminAnalyticsQuery, now = Date.now()) {
  const [meta, rows] = await env.APP_DB.batch<Record<string, unknown>>([
    env.APP_DB.prepare(
      "SELECT key,value FROM analytics_metadata WHERE key IN('retention_collected_from','retention_aggregated_at')",
    ),
    env.APP_DB.prepare(
      `SELECT metric,game,kind,${counters.map((c) => `SUM(${c}) AS ${c}`).join(",")} FROM analytics_retention_daily WHERE day>=? AND day<=? AND internal=? ${q.game === "all" ? "" : "AND game=?"} GROUP BY metric,game,kind ORDER BY metric,game,kind`,
    ).bind(
      q.from,
      q.to,
      Number(q.includeInternal === "true"),
      ...(q.game === "all" ? [] : [q.game]),
    ),
  ]);
  const values = new Map(meta!.results.map((r) => [String(r.key), Number(r.value)])),
    collected = values.get("retention_collected_from")!,
    at = values.get("retention_aggregated_at") ?? null;
  const measured = at !== null && q.to >= day(collected) && q.from <= day(now);
  const data = measured ? rows!.results : [];
  const map = (r: Record<string, unknown>) => ({
    game: r.game,
    kind: r.kind,
    enrolled: r.enrolled,
    eligible: r.eligible,
    retained: Number(r.eligible) > 0 ? Number(r.retained) : 0,
    retainedNextDay: Number(r.eligible) > 0 ? Number(r.retained_next_day) : 0,
    observing: r.observing,
    unknown: r.unknown,
    rate:
      r.metric !== "placement" && Number(r.eligible)
        ? Number(r.retained) / Number(r.eligible)
        : null,
    nextDayRate:
      r.metric !== "placement" && Number(r.eligible)
        ? Number(r.retained_next_day) / Number(r.eligible)
        : null,
    reached: [1, 2, 3, 4, 5].map((n) => Number(r[`reached${n}`])),
  });
  return retentionAnalyticsSchema.parse({
    collectedFromMs: collected,
    aggregatedAtMs: at,
    metricVersion: 2,
    status: at === null ? "unmeasured" : now - at > 300000 ? "delayed" : "ready",
    coverage: !measured
      ? "unmeasured"
      : q.from < day(collected) || q.to >= day(now)
        ? "partial"
        : "ready",
    returns: data.filter((r) => r.metric === "return").map(map),
    placement: data.filter((r) => r.metric === "placement").map(map),
    postPlacement: data.filter((r) => r.metric === "post-placement").map(map),
  });
}
