import {
  historyEntrySchema,
  statisticsSchema,
  type Room,
  type RoomMode,
  type RoundReplay,
} from "@tetraboard/protocol";

type FinishedGame = Extract<
  import("@tetraboard/four-reversi").FourReversiState,
  { status: "finished" }
>;
export type ArchivedMatch = {
  formatVersion: 1;
  id: string;
  roomId: string;
  instanceId: string;
  startedAt: number;
  finishedAt: number;
  game: FinishedGame;
  players: Room["players"];
  owners: Record<string, string>;
  replay: RoundReplay | null;
};
export function archivePlayers(match: ArchivedMatch) {
  return match.players.map((player) => {
    const color = player.color!;
    const result = match.game.result;
    const standing =
      result.mode === "singles" ? result.standings.find((s) => s.color === color) : undefined;
    const team = color === "black" || color === "red" ? "black-red" : "white-blue";
    return {
      participantId: player.id,
      name: player.kind === "cpu" ? `CPU Lv${player.level}` : player.name,
      username: player.username ?? null,
      avatarUrl: player.avatarUrl ?? null,
      kind: player.kind,
      level: player.kind === "cpu" ? player.level : null,
      color,
      placement: standing?.rank ?? null,
      outcome:
        result.mode === "singles"
          ? ("placement" as const)
          : result.winner === null
            ? ("draw" as const)
            : result.winner === team
              ? ("win" as const)
              : ("loss" as const),
    };
  });
}
export async function persistMatch(env: Env, match: ArchivedMatch): Promise<void> {
  const recordKey = `matches/v1/${match.id}.json`;
  await env.OBJECT_STORAGE.put(recordKey, JSON.stringify(match), {
    httpMetadata: { contentType: "application/json" },
  });
  const statements = [
    env.APP_DB.prepare(`INSERT OR IGNORE INTO gameMatch
    (id, roomId, game, mode, startedAt, finishedAt, recordKey, createdAt, finalState, formatVersion)
    VALUES (?, ?, 'four-reversi', ?, ?, ?, ?, ?, ?, 1)`).bind(
      match.id,
      match.roomId,
      match.game.mode,
      match.startedAt,
      match.finishedAt,
      recordKey,
      match.finishedAt,
      JSON.stringify(match.game),
    ),
  ];
  for (const [seat, player] of archivePlayers(match).entries()) {
    statements.push(
      env.APP_DB.prepare(`INSERT OR IGNORE INTO gameMatchPlayer
      (matchId, participantId, name, avatarUrl, isGuest, seat, outcome, placement, color, username, kind, level)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
        match.id,
        player.participantId,
        player.name,
        player.avatarUrl,
        player.kind === "human" && !match.owners[player.participantId] ? 1 : 0,
        String(seat),
        player.outcome,
        player.placement,
        player.color,
        player.username,
        player.kind,
        player.level,
      ),
    );
  }
  for (const [participantId, userId] of Object.entries(match.owners)) {
    statements.push(
      env.APP_DB.prepare(
        "INSERT OR IGNORE INTO gameMatchOwner (matchId, userId, participantId, expiresAt) VALUES (?, ?, ?, NULL)",
      ).bind(match.id, userId, participantId),
    );
  }
  await env.APP_DB.batch(statements);
}
const ownedGames = `FROM gameMatchOwner o JOIN gameMatch m ON m.id = o.matchId
  JOIN gameMatchPlayer p ON p.matchId = m.id AND p.participantId = o.participantId
  WHERE o.userId = ? AND m.game = 'four-reversi' AND m.mode = ? AND o.expiresAt IS NULL`;
export async function readStatistics(db: D1Database, userId: string, mode: RoomMode) {
  const row = await db
    .prepare(`SELECT COUNT(*) total,
    COALESCE(SUM(p.placement = 1), 0) first, COALESCE(SUM(p.placement = 2), 0) second,
    COALESCE(SUM(p.placement = 3), 0) third, COALESCE(SUM(p.placement = 4), 0) fourth,
    COALESCE(SUM(p.outcome = 'win'), 0) wins, COALESCE(SUM(p.outcome = 'loss'), 0) losses,
    COALESCE(SUM(p.outcome = 'draw'), 0) draws ${ownedGames}`)
    .bind(userId, mode)
    .first();
  return statisticsSchema.parse({ ...row, mode });
}
export function parseHistoryCursor(cursor?: string): { at: number; id: string } | null {
  if (!cursor) return null;
  const match = /^(\d{1,16}):([a-zA-Z0-9_-]{1,200})$/.exec(cursor);
  if (!match || !Number.isSafeInteger(Number(match[1]))) throw new TypeError("Invalid cursor");
  return { at: Number(match[1]), id: match[2] };
}
export async function readHistory(db: D1Database, userId: string, mode: RoomMode, cursor?: string) {
  const position = parseHistoryCursor(cursor);
  const query = `SELECT m.id, m.mode, m.finishedAt, m.finalState ${ownedGames}
    ${position ? "AND (m.finishedAt < ? OR (m.finishedAt = ? AND m.id < ?))" : ""}
    ORDER BY m.finishedAt DESC, m.id DESC LIMIT 21`;
  const rows = await db
    .prepare(query)
    .bind(userId, mode, ...(position ? [position.at, position.at, position.id] : []))
    .all<{ id: string; mode: string; finishedAt: number; finalState: string }>();
  const page = rows.results.slice(0, 20);
  const entries = [];
  for (const row of page) {
    const players = await db
      .prepare(
        `SELECT participantId, name, username, avatarUrl, kind, level, color, placement, outcome FROM gameMatchPlayer WHERE matchId = ? ORDER BY COALESCE(placement, 99), CASE color WHEN 'black' THEN 0 WHEN 'red' THEN 1 WHEN 'white' THEN 2 ELSE 3 END`,
      )
      .bind(row.id)
      .all();
    entries.push(
      historyEntrySchema.parse({
        ...row,
        finalState: JSON.parse(row.finalState),
        players: players.results,
      }),
    );
  }
  const last = page.at(-1);
  return {
    entries,
    nextCursor: rows.results.length > 20 && last ? `${last.finishedAt}:${last.id}` : null,
  };
}
export async function readRanking(db: D1Database, mode: RoomMode, metric: "wins" | "games") {
  const count =
    metric === "games"
      ? "COUNT(*)"
      : mode === "singles"
        ? "SUM(p.placement = 1)"
        : "SUM(p.outcome = 'win')";
  const rows = await db
    .prepare(`WITH scores AS (
    SELECT u.id, u.name, u.username, u.image AS avatarUrl, ${count} AS count
    FROM gameMatchOwner o JOIN gameMatch m ON m.id = o.matchId
    JOIN gameMatchPlayer p ON p.matchId = m.id AND p.participantId = o.participantId
    JOIN user u ON u.id = o.userId
    WHERE m.game = 'four-reversi' AND m.mode = ? AND o.expiresAt IS NULL
      AND u.profileCompleted = 1 AND COALESCE(u.isAnonymous, 0) = 0 AND COALESCE(u.isTestUser, 0) = 0
    GROUP BY u.id
  ) SELECT name, username, avatarUrl, count, RANK() OVER (ORDER BY count DESC) AS rank
    FROM scores ORDER BY count DESC, id ASC LIMIT 10`)
    .bind(mode)
    .all();
  return { entries: rows.results };
}
