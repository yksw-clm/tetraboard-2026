import {
  rankTournamentStandings,
  tournamentRankPointsUnits,
  tournamentRules,
  type TournamentInput,
  type TournamentPublic,
  type TournamentRecord,
  type TournamentStanding,
  type TournamentLobbySections,
  type TournamentList,
  type TournamentListItem,
} from "@tetraboard/protocol";
import type { GameId, GameScope } from "@tetraboard/protocol/games";
import { profileAvatarUrl } from "../accounts/auth";
import type { ShogiMatchRecord } from "../rooms/shogiMatchStore";
import type { TournamentRoomContext } from "../rooms/tournamentRoom";

export type TournamentRow = {
  key: string;
  public_id: number | null;
  name: string;
  description: string;
  rules_description: string;
  starts_at_ms: number | null;
  ends_at_ms: number | null;
  published: number;
  version: number;
  rule_version: 1;
  finalized_at_ms: number | null;
  created_at_ms: number;
  updated_at_ms: number;
};
export function readTournament(db: D1Database, key: string) {
  return db.prepare("SELECT * FROM tournaments WHERE key=?").bind(key).first<TournamentRow>();
}
export function publicTournament(db: D1Database, id: number) {
  return db
    .prepare("SELECT * FROM tournaments WHERE public_id=? AND published=1")
    .bind(id)
    .first<TournamentRow>();
}
export function stage(row: TournamentRow, now = Date.now()) {
  if (!row.published) return "draft" as const;
  if (row.finalized_at_ms !== null) return "finished" as const;
  if (now < row.starts_at_ms!) return "upcoming" as const;
  return now < row.ends_at_ms! ? ("active" as const) : ("settling" as const);
}
export async function entryCount(db: D1Database, key: string) {
  return (await db
    .prepare("SELECT COUNT(*) AS n FROM tournament_entries WHERE tournament_key=? AND deleted=0")
    .bind(key)
    .first<{ n: number }>())!.n;
}
export async function record(db: D1Database, row: TournamentRow): Promise<TournamentRecord> {
  return {
    key: row.key,
    id: row.public_id,
    name: row.name,
    description: row.description,
    rulesDescription: row.rules_description,
    startsAtMs: row.starts_at_ms,
    endsAtMs: row.ends_at_ms,
    published: !!row.published,
    version: row.version,
    ruleVersion: row.rule_version,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    entryCount: await entryCount(db, row.key),
    status: stage(row),
  };
}
type PublicCounts = Pick<
  TournamentPublic,
  "entryCount" | "waitingCount" | "playingCount" | "pendingCount" | "completedCount"
>;
function summarize(row: TournamentRow, counts: PublicCounts, now: number): TournamentPublic {
  if (!row.published || !row.public_id) throw new Error("Unpublished tournament");
  return {
    id: row.public_id,
    name: row.name,
    description: row.description,
    rulesDescription: row.rules_description,
    startsAtMs: row.starts_at_ms!,
    endsAtMs: row.ends_at_ms!,
    status: stage(row, now) as TournamentPublic["status"],
    ...counts,
    ruleVersion: 1,
    finalizedAtMs: row.finalized_at_ms,
  };
}
export async function publicSummary(
  db: D1Database,
  row: TournamentRow,
  now = Date.now(),
): Promise<TournamentPublic> {
  if (!row.published || !row.public_id) throw new Error("Unpublished tournament");
  const counts = await db
    .prepare(`SELECT
    SUM(phase='playing') AS playing, SUM(phase IN ('reserved','saving')) AS pending,
    SUM(phase='saved') AS completed FROM tournament_matches WHERE tournament_key=?`)
    .bind(row.key)
    .first<{ playing: number | null; pending: number | null; completed: number | null }>();
  const waiting = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM tournament_wait_reservations w WHERE tournament_key=? AND lease_until_ms>? AND match_operation_id IS NULL
        AND NOT EXISTS(SELECT 1 FROM tournament_match_players p JOIN tournament_matches m ON m.id=p.match_id
          WHERE p.account_id=w.account_id AND m.tournament_key=w.tournament_key AND m.phase='reserved')`,
    )
    .bind(row.key, now)
    .first<{ n: number }>();
  return summarize(
    row,
    {
      entryCount: await entryCount(db, row.key),
      waitingCount: waiting!.n,
      playingCount: counts?.playing ?? 0,
      pendingCount: counts?.pending ?? 0,
      completedCount: counts?.completed ?? 0,
    },
    now,
  );
}
export async function lobbySections(
  db: D1Database,
  game: GameId,
  now: number,
): Promise<TournamentLobbySections> {
  if (game !== tournamentRules.game) return { current: [], upcoming: [], serverTimeMs: now };
  const cutoff = now - 86_400_000;
  // 全件掲載でも、大会ごとの人数取得でD1との往復を増やしません。
  const rows = await db
    .prepare(`SELECT t.*,
    (SELECT COUNT(*) FROM tournament_entries e WHERE e.tournament_key=t.key AND e.deleted=0) AS entryCount,
    (SELECT COUNT(*) FROM tournament_wait_reservations w WHERE w.tournament_key=t.key AND w.lease_until_ms>?
      AND w.match_operation_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM tournament_match_players p JOIN tournament_matches m ON m.id=p.match_id
        WHERE p.account_id=w.account_id AND m.tournament_key=w.tournament_key AND m.phase='reserved')) AS waitingCount,
    (SELECT COUNT(*) FROM tournament_matches m WHERE m.tournament_key=t.key AND m.phase='playing') AS playingCount,
    (SELECT COUNT(*) FROM tournament_matches m WHERE m.tournament_key=t.key AND m.phase IN ('reserved','saving')) AS pendingCount,
    (SELECT COUNT(*) FROM tournament_matches m WHERE m.tournament_key=t.key AND m.phase='saved') AS completedCount
    FROM tournaments t WHERE t.published=1 AND t.ends_at_ms>?
    ORDER BY t.starts_at_ms,t.public_id`)
    .bind(now, cutoff)
    .all<TournamentRow & PublicCounts>();
  const current: TournamentPublic[] = [],
    upcoming: TournamentPublic[] = [];
  for (const row of rows.results) {
    const summary = summarize(
      row,
      {
        entryCount: row.entryCount,
        waitingCount: row.waitingCount,
        playingCount: row.playingCount,
        pendingCount: row.pendingCount,
        completedCount: row.completedCount,
      },
      now,
    );
    if (summary.status === "upcoming") upcoming.push(summary);
    else if (summary.status === "active" || summary.endsAtMs <= now) current.push(summary);
  }
  current.sort(
    (a, b) =>
      Number(b.status === "active") - Number(a.status === "active") ||
      b.endsAtMs - a.endsAtMs ||
      b.id - a.id,
  );
  upcoming.sort((a, b) => a.startsAtMs - b.startsAtMs || a.id - b.id);
  return { current, upcoming, serverTimeMs: now };
}
export async function publicTournamentList(
  db: D1Database,
  game: GameScope,
  cursor: string | undefined,
  now: number,
): Promise<TournamentList> {
  if (game !== "all" && game !== tournamentRules.game)
    return { tournaments: [], nextCursor: null, serverTimeMs: now };
  const [at, id] = cursor?.split(":") ?? [];
  const result = await db
    .prepare(`SELECT t.*,
      (SELECT COUNT(*) FROM tournament_entries e WHERE e.tournament_key=t.key AND e.deleted=0) AS entryCount
    FROM tournaments t WHERE t.published=1
    ${cursor ? "AND (t.starts_at_ms<? OR (t.starts_at_ms=? AND t.public_id<?))" : ""}
    ORDER BY t.starts_at_ms DESC,t.public_id DESC LIMIT 21`)
    .bind(...(cursor ? [Number(at), Number(at), Number(id)] : []))
    .all<TournamentRow & { entryCount: number }>();
  const rows = result.results.slice(0, 20);
  const finalized = rows.filter((row) => row.finalized_at_ms !== null).map((row) => row.key);
  const winners = new Map<string, InternalStanding[]>();
  if (finalized.length) {
    const scores = await db
      .prepare(`SELECT e.tournament_key AS tournamentKey,
      e.id AS entryId,e.account_id AS accountId,e.deleted,u.name,u.username,u.avatarKey,u.isAnonymous,
      s.points_units AS pointsUnits,s.games,s.first,s.second,s.third,s.fourth,s.knockouts,s.rank_sum AS rankSum,s.final_rank AS finalRank
      FROM tournament_entries e JOIN tournament_scores s ON s.entry_id=e.id AND s.tournament_key=e.tournament_key
      LEFT JOIN user u ON u.id=e.account_id AND e.deleted=0 AND NOT EXISTS(SELECT 1 FROM deleted_accounts d WHERE d.id=u.id)
      WHERE e.tournament_key IN (${finalized.map(() => "?").join(",")}) AND s.final_rank=1 AND s.games>0
      ORDER BY e.tournament_key,e.id`)
      .bind(...finalized)
      .all<ScoreRow & { tournamentKey: string }>();
    for (const score of scores.results) {
      const group = winners.get(score.tournamentKey) ?? [];
      group.push(standingFromRow(score));
      winners.set(score.tournamentKey, group);
    }
  }
  const tournaments: TournamentListItem[] = rows.map((row) => ({
    id: row.public_id!,
    game: tournamentRules.game,
    name: row.name,
    entryCount: row.entryCount,
    startsAtMs: row.starts_at_ms!,
    endsAtMs: row.ends_at_ms!,
    status: stage(row, now) as TournamentPublic["status"],
    winners: (winners.get(row.key) ?? [])
      .sort(
        (a, b) =>
          (a.username ?? "").localeCompare(b.username ?? "") || a.entryId.localeCompare(b.entryId),
      )
      .map((standing) => {
        const { name, avatarUrl, isGuest } = visibleStanding(standing);
        return { name, avatarUrl, ...(isGuest ? { isGuest: true } : {}) };
      }),
  }));
  const last = rows.at(-1);
  return {
    tournaments,
    nextCursor:
      result.results.length > 20 && last ? `${last.starts_at_ms}:${last.public_id}` : null,
    serverTimeMs: now,
  };
}
export async function createDraft(db: D1Database, input: TournamentInput) {
  const key = crypto.randomUUID(),
    now = Date.now();
  await db
    .prepare(
      `INSERT INTO tournaments(key,name,description,rules_description,starts_at_ms,ends_at_ms,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?)`,
    )
    .bind(
      key,
      input.name,
      input.description,
      input.rulesDescription,
      input.startsAtMs,
      input.endsAtMs,
      now,
      now,
    )
    .run();
  return key;
}
export async function updateDraft(
  db: D1Database,
  key: string,
  input: TournamentInput,
  version: number,
) {
  return (
    (
      await db
        .prepare(`UPDATE tournaments SET name=?,description=?,rules_description=?,starts_at_ms=?,ends_at_ms=?,version=version+1,updated_at_ms=?
    WHERE key=? AND version=? AND (published=0 OR (starts_at_ms IS ? AND ends_at_ms IS ?))`)
        .bind(
          input.name,
          input.description,
          input.rulesDescription,
          input.startsAtMs,
          input.endsAtMs,
          Date.now(),
          key,
          version,
          input.startsAtMs,
          input.endsAtMs,
        )
        .run()
    ).meta.changes === 1
  );
}
export function cursorOffset(value?: string) {
  if (!value) return 0;
  if (value.length > 512) return null;
  try {
    const parsed: unknown = JSON.parse(atob(value));
    if (
      typeof parsed === "number" &&
      Number.isSafeInteger(parsed) &&
      parsed >= 0 &&
      parsed <= 10_000_000
    )
      return parsed;
  } catch {
    /* invalid cursor */
  }
  return null;
}
export const nextOffset = (offset: number) => btoa(JSON.stringify(offset));
export async function adminList(db: D1Database, offset: number) {
  const rows = await db
    .prepare("SELECT * FROM tournaments ORDER BY starts_at_ms DESC,key DESC LIMIT 51 OFFSET ?")
    .bind(offset)
    .all<TournamentRow>();
  return {
    tournaments: await Promise.all(rows.results.slice(0, 50).map((row) => record(db, row))),
    nextCursor: rows.results.length > 50 ? nextOffset(offset + 50) : null,
  };
}
type ScoreRow = {
  entryId: string;
  accountId: string | null;
  deleted: number;
  name: string | null;
  username: string | null;
  isAnonymous: number | null;
  avatarKey: string | null;
  pointsUnits: number;
  games: number;
  first: number;
  second: number;
  third: number;
  fourth: number;
  knockouts: number;
  rankSum: number;
  finalRank: number | null;
};
export type InternalStanding = TournamentStanding & { entryId: string; accountId: string | null };
function standingFromRow(v: ScoreRow): InternalStanding {
  return {
    entryId: v.entryId,
    accountId: v.deleted ? null : v.accountId,
    rank: v.finalRank,
    name: v.name ?? "退会したプレイヤー",
    username: v.username,
    ...(v.isAnonymous ? { isGuest: true } : {}),
    avatarUrl: profileAvatarUrl(v.avatarKey),
    pointsUnits: v.pointsUnits,
    games: v.games,
    first: v.first,
    second: v.second,
    third: v.third,
    fourth: v.fourth,
    knockouts: v.knockouts,
    rankSum: v.rankSum,
  };
}
export async function allStandings(
  db: D1Database,
  row: TournamentRow,
): Promise<InternalStanding[]> {
  const values = await db
    .prepare(`SELECT e.id AS entryId,e.account_id AS accountId,e.deleted,u.name,u.username,u.avatarKey,u.isAnonymous,
    COALESCE(s.points_units,0) AS pointsUnits,COALESCE(s.games,0) AS games,
    COALESCE(s.first,0) AS first,COALESCE(s.second,0) AS second,COALESCE(s.third,0) AS third,COALESCE(s.fourth,0) AS fourth,
    COALESCE(s.knockouts,0) AS knockouts,COALESCE(s.rank_sum,0) AS rankSum,s.final_rank AS finalRank
    FROM tournament_entries e LEFT JOIN tournament_scores s ON s.entry_id=e.id
    LEFT JOIN user u ON u.id=e.account_id AND e.deleted=0 AND NOT EXISTS(SELECT 1 FROM deleted_accounts d WHERE d.id=u.id)
    WHERE e.tournament_key=? AND (e.deleted=0 OR (? IS NOT NULL AND s.final_rank IS NOT NULL))`)
    .bind(row.key, row.finalized_at_ms)
    .all<ScoreRow>();
  const standings = values.results.map(standingFromRow);
  return row.finalized_at_ms === null
    ? rankTournamentStandings(standings)
    : standings.sort(
        (a, b) =>
          (a.rank ?? Infinity) - (b.rank ?? Infinity) ||
          (a.username ?? "").localeCompare(b.username ?? ""),
      );
}
export function visibleStanding(
  { entryId: _entry, accountId, ...score }: InternalStanding,
  viewer?: string,
): TournamentStanding {
  return { ...score, ...(viewer && accountId === viewer ? { self: true } : {}) };
}
export async function standingsPage(
  db: D1Database,
  row: TournamentRow,
  viewer: string | undefined,
  all = false,
  offset = 0,
) {
  if (stage(row) === "upcoming") return { standings: [], self: null, nextCursor: null };
  const values = await allStandings(db, row);
  const own = values.find((v) => v.accountId === viewer);
  const page = all
    ? values.slice(offset, offset + 50)
    : values.filter((v) => v.rank !== null && v.rank <= 5);
  return {
    standings: page.map((v) => visibleStanding(v, viewer)),
    self: own ? visibleStanding(own, viewer) : null,
    nextCursor: all && values.length > offset + 50 ? nextOffset(offset + 50) : null,
  };
}
export async function finalizeTournament(db: D1Database, key: string, now = Date.now()) {
  const row = await readTournament(db, key);
  if (!row || !row.published || row.finalized_at_ms !== null || row.ends_at_ms! > now) return;
  const pending = await db
    .prepare(
      "SELECT 1 FROM tournament_matches WHERE tournament_key=? AND phase IN ('reserved','playing','saving') LIMIT 1",
    )
    .bind(key)
    .first();
  if (pending) return;
  const standings = await allStandings(db, row);
  const guard = `NOT EXISTS(SELECT 1 FROM tournament_matches WHERE tournament_key=? AND phase IN ('reserved','playing','saving'))
    AND (SELECT COUNT(*) FROM tournament_entries WHERE tournament_key=? AND deleted=0)=?
    AND EXISTS(SELECT 1 FROM tournaments WHERE key=? AND finalized_at_ms IS NULL)`;
  const guardValues = [key, key, standings.length, key];
  await db.batch([
    ...standings
      .filter((v) => v.games > 0)
      .map((v) =>
        db
          .prepare(`UPDATE tournament_scores SET final_rank=? WHERE entry_id=? AND ${guard}`)
          .bind(v.rank, v.entryId, ...guardValues),
      ),
    db
      .prepare(
        `UPDATE tournaments SET finalized_at_ms=?,updated_at_ms=? WHERE key=? AND ends_at_ms<=? AND finalized_at_ms IS NULL AND ${guard}`,
      )
      .bind(now, now, key, now, ...guardValues),
  ]);
}

/** Called in the same D1 batch that publishes the verified replay. The event PK makes retries harmless. */
export function tournamentMatchStatements(
  db: D1Database,
  context: TournamentRoomContext,
  record: ShogiMatchRecord,
): D1PreparedStatement[] {
  if (
    record.id !== context.matchId ||
    record.settings.game !== "four-shogi" ||
    record.game.result?.mode !== "singles" ||
    record.participants.length !== 4 ||
    record.participants.some((p) => p.kind !== "human") ||
    record.startedAtMs < context.startsAtMs ||
    record.startedAtMs >= context.endsAtMs
  )
    throw new Error("Invalid tournament result");
  const standings = record.game.result.standings;
  const statements = record.participants.map((p) => {
    const rank = standings.find((s) => s.side === p.side)?.rank;
    if (!rank) throw new Error("Missing tournament rank");
    const units = tournamentRankPointsUnits(rank, standings.filter((s) => s.rank === rank).length);
    return db
      .prepare(`INSERT INTO tournament_point_events(match_id,entry_id,rank,knockouts,points_units)
      SELECT m.id,p.entry_id,?,?,? FROM tournament_matches m
      JOIN tournament_match_players p ON p.match_id=m.id
      JOIN tournaments t ON t.key=m.tournament_key
      WHERE m.id=? AND m.tournament_key=? AND m.room_id=? AND m.instance_id=? AND p.player_id=?
        AND m.phase IN ('reserved','playing','saving','saved') AND t.finalized_at_ms IS NULL
        AND EXISTS(SELECT 1 FROM matches WHERE id=m.id AND game='four-shogi')
      ON CONFLICT(match_id,entry_id) DO NOTHING`)
      .bind(
        rank,
        record.knockouts[p.side],
        units,
        context.matchId,
        context.tournamentKey,
        record.roomId,
        record.instanceId,
        p.id,
      );
  });
  statements.push(
    db
      .prepare(
        `UPDATE tournament_matches SET phase='saved',started_at_ms=?,finished_at_ms=?,updated_at_ms=? WHERE id=? AND tournament_key=? AND room_id=? AND instance_id=? AND phase IN ('reserved','playing','saving') AND (SELECT COUNT(*) FROM tournament_point_events WHERE match_id=?)=4`,
      )
      .bind(
        record.startedAtMs,
        record.endedAtMs,
        Date.now(),
        context.matchId,
        context.tournamentKey,
        record.roomId,
        record.instanceId,
        context.matchId,
      ),
  );
  return statements;
}
