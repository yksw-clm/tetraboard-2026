import {
  gameIds,
  ratedMatchmakingRules,
  type AdminUser,
  type AdminUsersQuery,
} from "@tetraboard/protocol";
import { analyticsRetentionMs } from "@tetraboard/protocol/privacy";
import { accountAvatarUrl } from "../accounts/auth";
import { accountCreatedAtMsSql } from "../accounts/timestamps";
import { publicRatingForMu } from "../rooms/fourReversiRating";
const ratedGames = ["shogi", "reversi", "four-shogi", "four-reversi"] as const;
const tables = [
  "shogi_rating_changes",
  "reversi_rating_changes",
  "four_shogi_rating_changes",
  "four_reversi_rating_changes",
];
export class UserQueryError extends Error {}
export async function readAdminUsers(
  db: D1Database,
  query: AdminUsersQuery,
  id?: string,
  now = Date.now(),
) {
  if (
    (query.from === undefined) !== (query.to === undefined) ||
    (query.from &&
      query.to &&
      (query.to < query.from || Date.parse(query.to) - Date.parse(query.from) > 366 * 3 * 86400000))
  )
    throw new UserQueryError();
  const from = query.from ?? "",
    to = query.to ?? "";
  const periodAvailable = Boolean(
    from &&
    to <= new Date(now + 32400000).toISOString().slice(0, 10) &&
    from > new Date(now - analyticsRetentionMs + 32400000).toISOString().slice(0, 10),
  );
  const signature = Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(
          JSON.stringify([
            query.kind,
            query.search,
            from,
            to,
            query.game,
            query.sort,
            query.direction,
          ]),
        ),
      ),
    ),
  )
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
  let cursor: { missing: number; value: string | number; id: string } | null = null;
  if (query.cursor) {
    try {
      const raw = atob(query.cursor);
      let c;
      try {
        c = JSON.parse(raw);
      } catch {
        c = JSON.parse(decodeURIComponent(raw));
      }
      if (
        c.signature === undefined &&
        query.sort === "created" &&
        query.direction === "desc" &&
        !from &&
        query.game === "all"
      ) {
        if (!Number.isSafeInteger(c.at) || c.at < 0) throw new Error();
        cursor = { missing: 0, value: c.at, id: c.id };
      } else if (c.signature === signature) cursor = c;
      else throw new Error();
      if (
        !cursor ||
        ![0, 1].includes(cursor.missing) ||
        !["string", "number"].includes(typeof cursor.value) ||
        typeof cursor.id !== "string" ||
        !cursor.id ||
        cursor.id.length > 200 ||
        (typeof cursor.value === "number" && !Number.isFinite(cursor.value))
      )
        throw new Error();
    } catch {
      throw new UserQueryError();
    }
  }
  const metric = {
    created: "createdAtMs",
    lastLogin: "last_login_at_ms",
    lastUsed: "last_used_day",
    completed: "completed",
    periodCompleted: "periodCompleted",
    rating: "selectedRating",
  }[query.sort];
  const order = query.direction === "asc" ? "ASC" : "DESC",
    cmp = query.direction === "asc" ? ">" : "<";
  const search = `%${query.search.replace(/^@/, "").replace(/[\\%_]/g, "\\$&")}%`;
  const ratings = tables
    .map(
      (t, i) =>
        `(SELECT json_object('rating',${i < 2 ? "rating_after" : "mu_after"},'ratedGames',rated_games) FROM ${t} WHERE account_id=u.id ORDER BY rated_games DESC LIMIT 1) AS rating${i}`,
    )
    .join(",");
  const sql = `WITH totals AS (SELECT account_id,SUM(completed) AS count FROM account_game_totals WHERE (?='all' OR game=?) GROUP BY account_id),
    periods AS (SELECT account_id,SUM(completed) AS count FROM account_game_daily WHERE day>=? AND day<=? AND (?='all' OR game=?) GROUP BY account_id),
    base AS (SELECT u.*,${accountCreatedAtMsSql("u.createdAt")} AS createdAtMs,usage.last_login_at_ms,usage.last_used_day,
      CASE WHEN ready.account_id IS NOT NULL THEN COALESCE(totals.count,0) END AS completed,
      CASE WHEN ? AND ready.account_id IS NOT NULL THEN COALESCE(periods.count,0) END AS periodCompleted,
      ${ratings},
      (SELECT json_group_array(json_object('game',g.value,'completed',COALESCE(t.completed,0),'periodCompleted',COALESCE(p.count,0))) FROM json_each(?) g
       LEFT JOIN account_game_totals t ON t.account_id=u.id AND t.game=g.value
       LEFT JOIN (SELECT game,SUM(completed) AS count FROM account_game_daily WHERE account_id=u.id AND day>=? AND day<=? GROUP BY game) p ON p.game=g.value) AS gamesJson
      FROM user u LEFT JOIN account_insights_ready ready ON ready.account_id=u.id LEFT JOIN account_usage usage ON usage.account_id=u.id
      LEFT JOIN totals ON totals.account_id=u.id LEFT JOIN periods ON periods.account_id=u.id
      WHERE COALESCE(u.isAnonymous,0)=? AND NOT EXISTS(SELECT 1 FROM guest_account_merges WHERE guest_id=u.id)
      AND NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE id=u.id) AND (u.name LIKE ? ESCAPE '\\' OR u.username LIKE ? ESCAPE '\\') ${id ? "AND u.id=?" : ""}),
    rated AS (SELECT *,CASE WHEN COALESCE(isAnonymous,0)=0 THEN CASE ?
      WHEN 'shogi' THEN CASE WHEN json_extract(rating0,'$.ratedGames')>=5 THEN json_extract(rating0,'$.rating') END
      WHEN 'reversi' THEN CASE WHEN json_extract(rating1,'$.ratedGames')>=5 THEN json_extract(rating1,'$.rating') END
      WHEN 'four-shogi' THEN CASE WHEN json_extract(rating2,'$.ratedGames')>=5 THEN json_extract(rating2,'$.rating') END
      WHEN 'four-reversi' THEN CASE WHEN json_extract(rating3,'$.ratedGames')>=5 THEN json_extract(rating3,'$.rating') END END END AS selectedRating FROM base),
    ordered AS (SELECT *,(${metric} IS NULL) AS missing,COALESCE(${metric},0) AS value FROM rated)
    SELECT * FROM ordered ${cursor ? `WHERE missing>? OR (missing=? AND (value ${cmp} ? OR (value=? AND id ${cmp} ?)))` : ""}
    ORDER BY missing ASC,value ${order},id ${order} LIMIT ${id ? "1" : "51"}`;
  const [state, results] = await db.batch<Record<string, unknown>>([
    db.prepare(
      "SELECT (SELECT value FROM analytics_metadata WHERE key='account_insights_aggregated_at') AS aggregated_at_ms,collected_from_ms,(backfill_complete=1 AND NOT EXISTS(SELECT 1 FROM account_totals_dirty)) AS backfill_complete FROM analytics_foundation_state WHERE id=1",
    ),
    db
      .prepare(sql)
      .bind(
        query.game,
        query.game,
        from,
        to,
        query.game,
        query.game,
        Number(periodAvailable),
        JSON.stringify(gameIds),
        from,
        to,
        query.kind === "guest" ? 1 : 0,
        search,
        search,
        ...(id ? [id] : []),
        query.game,
        ...(cursor ? [cursor.missing, cursor.missing, cursor.value, cursor.value, cursor.id] : []),
      ),
  ]);
  const rows = results!.results;
  const users = rows.slice(0, 50).map((u): AdminUser => {
    const ratings: NonNullable<AdminUser["ratings"]> = {};
    ratedGames.forEach((g, i) => {
      const r = u[`rating${i}`] ? JSON.parse(String(u[`rating${i}`])) : null;
      const status = u.isAnonymous
        ? "ineligible"
        : r?.ratedGames >= ratedMatchmakingRules[g].placementGames
          ? "rated"
          : "placement";
      ratings[g] = {
        status,
        ratedGames: status === "ineligible" ? 0 : (r?.ratedGames ?? 0),
        rating: status === "rated" ? (i < 2 ? r.rating : publicRatingForMu(r.rating)) : null,
      };
    });
    return {
      id: String(u.id),
      name: String(u.name),
      username: u.username as string | null,
      avatarUrl: accountAvatarUrl(u as unknown as Parameters<typeof accountAvatarUrl>[0]),
      createdAtMs: Number(u.createdAtMs),
      profileCompleted: Boolean(u.profileCompleted),
      ...(u.isAnonymous ? { isGuest: true } : {}),
      lastLoginAtMs: u.last_login_at_ms as number | null,
      lastUsedDay: u.last_used_day as string | null,
      completed: u.completed as number | null,
      periodCompleted: u.periodCompleted as number | null,
      ratings,
      games: JSON.parse(String(u.gamesJson)).map(
        (g: { game: string; completed: number; periodCompleted: number }) => ({
          ...g,
          completed: u.completed === null ? null : g.completed,
          periodCompleted: u.periodCompleted === null ? null : g.periodCompleted,
        }),
      ),
    };
  });
  const last = rows[Math.min(49, rows.length - 1)];
  const at =
    state!.results[0]?.aggregated_at_ms == null
      ? null
      : Number(state!.results[0]!.aggregated_at_ms);
  return {
    status: at === null ? "unmeasured" : now - at > 300000 ? "delayed" : "ready",
    collectedFromMs: Number(state!.results[0]!.collected_from_ms),
    metricVersion: 1,
    users,
    nextCursor:
      rows.length > 50 && last
        ? btoa(
            encodeURIComponent(
              JSON.stringify({ signature, missing: last.missing, value: last.value, id: last.id }),
            ),
          )
        : null,
    periodAvailable,
    backfillComplete: Boolean(state!.results[0]?.backfill_complete),
    aggregatedAtMs: state!.results[0]?.aggregated_at_ms ?? null,
  };
}
