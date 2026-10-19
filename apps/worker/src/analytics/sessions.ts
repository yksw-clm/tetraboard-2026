import {
  analyticsSessionIdleMs,
  classifyDevice,
  classifyReferrer,
  sanitizeUtm,
  type AcquisitionInput,
} from "@tetraboard/protocol";
import { analyticsRetentionMs } from "@tetraboard/protocol/privacy";

export function sessionStatements(
  db: D1Database,
  input: {
    id: string;
    visitor: string;
    account: string | null;
    isTest: boolean;
    game: string | null;
    now: number;
    origin: string;
    userAgent: string | null;
    acquisition?: AcquisitionInput;
  },
) {
  const { id, visitor, account, isTest, game, now, acquisition } = input;
  const referrer = classifyReferrer(acquisition?.referrer ?? null, new URL(input.origin).hostname);
  const active = "visitor_id=? AND started_at_ms>? AND last_activity_ms>?";
  const activeArgs = [visitor, now - analyticsRetentionMs, now - analyticsSessionIdleMs];
  // batch内で既存の訪問を確認するため、別タブが同時に来ても最初の閲覧だけが作成します。
  return [
    db
      .prepare(`INSERT INTO analytics_sessions(id,visitor_id,account_id,started_at_ms,last_activity_ms,
      referrer_host,referrer_class,utm_source,utm_medium,utm_campaign,device)
      SELECT id,visitor_id,account_id,started_at_ms,started_at_ms,?,?,?,?,?,?
      FROM analytics_pageviews WHERE id=? AND visitor_id=? AND started_at_ms=? AND session_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM analytics_sessions WHERE ${active})
      ON CONFLICT(id) DO NOTHING`)
      .bind(
        referrer.host,
        referrer.category,
        sanitizeUtm(acquisition?.source ?? null),
        sanitizeUtm(acquisition?.medium ?? null),
        sanitizeUtm(acquisition?.campaign ?? null),
        acquisition ? classifyDevice(input.userAgent) : null,
        id,
        visitor,
        now,
        ...activeArgs,
      ),
    db
      .prepare(`UPDATE analytics_pageviews SET session_id=(SELECT id FROM analytics_sessions WHERE ${active}
      ORDER BY started_at_ms DESC,id LIMIT 1) WHERE id=? AND visitor_id=? AND started_at_ms=? AND session_id IS NULL`)
      .bind(...activeArgs, id, visitor, now),
    db
      .prepare(`UPDATE analytics_sessions SET last_activity_ms=MAX(last_activity_ms,?)
      WHERE id=(SELECT session_id FROM analytics_pageviews WHERE id=? AND visitor_id=? AND started_at_ms=?)`)
      .bind(now, id, visitor, now),
    ...["*", ...(game ? [game] : [])].map((scope) =>
      db
        .prepare(`INSERT INTO analytics_session_visits(session_id,game,started_at_ms,account_id,is_test)
      SELECT v.session_id,?,?,?,? FROM analytics_pageviews v JOIN analytics_sessions s ON s.id=v.session_id
      WHERE v.id=? AND v.visitor_id=? AND v.started_at_ms=?
      ON CONFLICT(session_id,game) DO NOTHING`)
        .bind(scope, now, account, Number(isTest), id, visitor, now),
    ),
  ];
}

export function sessionActivityStatement(
  db: D1Database,
  visitor: string,
  id: string,
  days: { day: string; milliseconds: number }[],
  now: number,
) {
  // 累積値の再送では延長せず、30分以上途絶えた古いタブから訪問を復活させません。
  return db
    .prepare(`UPDATE analytics_sessions SET last_activity_ms=MAX(last_activity_ms,?)
    WHERE id=(SELECT id FROM analytics_sessions WHERE visitor_id=? AND started_at_ms>? AND last_activity_ms>?
      ORDER BY started_at_ms DESC,id LIMIT 1)
    AND EXISTS(SELECT 1 FROM analytics_pageviews WHERE id=? AND visitor_id=?)
    AND (${days.map(() => "? > COALESCE((SELECT milliseconds FROM analytics_dwell WHERE view_id=? AND day=?),0)").join(" OR ")})`)
    .bind(
      now,
      visitor,
      now - analyticsRetentionMs,
      now - analyticsSessionIdleMs,
      id,
      visitor,
      ...days.flatMap((day) => [day.milliseconds, id, day.day]),
    );
}
