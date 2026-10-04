import { defaultGameId } from "@tetraboard/protocol/games";
import { Hono } from "hono";
import {
  listMatchesContract,
  getMatchContract,
  getMatchReplayContract,
  type RoomMode,
  type MatchGame,
} from "@tetraboard/protocol";
import { accountIdentity, profileAvatarUrl } from "./auth";
import { type MatchRecord } from "../rooms/matchStore";
import {
  readShogiMatchRecord,
  readShogiMatchReplayPage,
  type ShogiMatchRecord,
} from "../rooms/shogiMatchStore";
type StoredMatchRecord = MatchRecord | ShogiMatchRecord;
function isShogiRecord(record: StoredMatchRecord): record is ShogiMatchRecord {
  return record.settings.game === "four-shogi";
}
function readRecord(json: string): StoredMatchRecord {
  const record = JSON.parse(json) as StoredMatchRecord;
  return isShogiRecord(record) ? readShogiMatchRecord(json) : record;
}

export async function listMatches(
  db: D1Database,
  accountId: string,
  mode: RoomMode,
  cursor: { startedAtMs: number; id: string } | null,
  game: MatchGame = defaultGameId,
) {
  const sql = `SELECT m.record_json FROM account_match_history h
    JOIN matches m ON m.id = h.match_id WHERE h.account_id = ? AND h.game = ? AND m.game = h.game AND h.mode = ?`;
  const statement = cursor
    ? db
        .prepare(`${sql} AND (h.started_at_ms < ? OR (h.started_at_ms = ? AND h.match_id < ?))
      ORDER BY h.started_at_ms DESC, h.match_id DESC LIMIT 21`)
        .bind(accountId, game, mode, cursor.startedAtMs, cursor.startedAtMs, cursor.id)
    : db
        .prepare(`${sql} ORDER BY h.started_at_ms DESC, h.match_id DESC LIMIT 21`)
        .bind(accountId, game, mode);
  const rows = await statement.all<{ record_json: string }>();
  const records = rows.results.slice(0, 20).map((row) => readRecord(row.record_json));
  const avatars = await participantAvatars(db, records);
  const matches = records.map((record) => ({
    id: record.id,
    game: record.settings.game,
    mode: record.settings.mode,
    startedAtMs: record.startedAtMs,
    endedAtMs: record.endedAtMs,
    participants: publicParticipants(record, avatars),
    result: record.game.result,
  }));
  const last = matches.at(-1);
  return listMatchesContract.response.parse({
    matches,
    nextCursor: rows.results.length > 20 && last ? `${last.startedAtMs}:${last.id}` : null,
  });
}

export const matchRoutes = new Hono<{ Bindings: Env }>();
matchRoutes.get(listMatchesContract.path, async (c) => {
  c.header("Cache-Control", "no-store");
  try {
    const user = await accountIdentity(c.req.raw, c.env);
    if (!user) return c.json({ message: "ログインしてください。" }, 401);
    const query = listMatchesContract.query.safeParse({
      game: c.req.query("game"),
      mode: c.req.query("mode"),
      cursor: c.req.query("cursor"),
    });
    if (!query.success) return c.json({ message: "履歴の取得条件が正しくありません。" }, 400);
    return c.json(
      await listMatches(
        c.env.APP_DB,
        user.id,
        query.data.mode,
        query.data.cursor ?? null,
        query.data.game,
      ),
    );
  } catch {
    console.error("Match history request failed");
    return c.json({ message: "対局履歴を取得できませんでした。もう一度お試しください。" }, 503);
  }
});

async function participantAvatars(db: D1Database, records: StoredMatchRecord[]) {
  const accountIds = [
    ...new Set(
      records.flatMap((record) =>
        record.participants.flatMap((p) =>
          p.kind === "human" && p.accountId ? [p.accountId] : [],
        ),
      ),
    ),
  ];
  const avatars = new Map<string, string | null>();
  if (accountIds.length) {
    const profiles = await db
      .prepare(
        `SELECT id, avatarKey FROM user WHERE id IN (${accountIds.map(() => "?").join(",")})`,
      )
      .bind(...accountIds)
      .all<{ id: string; avatarKey: string | null }>();
    for (const profile of profiles.results)
      avatars.set(profile.id, profileAvatarUrl(profile.avatarKey));
  }
  return avatars;
}
function publicParticipants(record: StoredMatchRecord, avatars: Map<string, string | null>) {
  return record.participants.map((p) => ({
    id: p.id,
    name: p.name,
    ...("side" in p ? { side: p.side } : { color: p.color }),
    seat: p.seat,
    ...(p.kind === "cpu"
      ? { kind: "cpu" as const, level: p.level }
      : {
          kind: "human" as const,
          avatarUrl: p.accountId ? (avatars.get(p.accountId) ?? null) : null,
        }),
  }));
}

matchRoutes.get(getMatchContract.path, async (c) => {
  c.header("Cache-Control", "no-store");
  try {
    const user = await accountIdentity(c.req.raw, c.env);
    if (!user) return c.json({ message: "ログインしてください。" }, 401);
    const params = getMatchContract.params.safeParse(c.req.param());
    if (!params.success) return c.json({ message: "棋譜のURLが正しくありません。" }, 400);
    const row = await c.env.APP_DB.prepare(`SELECT m.record_json FROM account_match_history h
      JOIN matches m ON m.id = h.match_id WHERE h.account_id = ? AND h.match_id = ?`)
      .bind(user.id, params.data.matchId)
      .first<{ record_json: string }>();
    if (!row) return c.json({ message: "この棋譜は閲覧できません。" }, 404);
    const record = readRecord(row.record_json);
    const self = record.participants.find((p) => p.kind === "human" && p.accountId === user.id);
    if (!self) throw new Error("Match participant missing");
    const avatars = await participantAvatars(c.env.APP_DB, [record]);
    return c.json(
      getMatchContract.response.parse({
        match: {
          id: record.id,
          roomId: record.roomId,
          startedAtMs: record.startedAtMs,
          endedAtMs: record.endedAtMs,
          settings: record.settings,
          participants: publicParticipants(record, avatars),
          selfPlayerId: self.id,
          game: record.game,
          ...(isShogiRecord(record)
            ? { knockouts: record.knockouts }
            : { eliminations: record.eliminations }),
          replay: record.replay,
        },
      }),
    );
  } catch {
    console.error("Match detail request failed");
    return c.json({ message: "棋譜を取得できませんでした。もう一度お試しください。" }, 503);
  }
});

matchRoutes.get(getMatchReplayContract.path, async (c) => {
  c.header("Cache-Control", "no-store");
  try {
    const user = await accountIdentity(c.req.raw, c.env);
    if (!user) return c.json({ message: "ログインしてください。" }, 401);
    const params = getMatchReplayContract.params.safeParse(c.req.param());
    const query = getMatchReplayContract.query.safeParse({ cursor: c.req.query("cursor") });
    if (!params.success || !query.success)
      return c.json({ message: "棋譜の取得条件が正しくありません。" }, 400);
    const row = await c.env.APP_DB.prepare(`SELECT m.record_json FROM account_match_history h
      JOIN matches m ON m.id = h.match_id WHERE h.account_id = ? AND h.match_id = ?`)
      .bind(user.id, params.data.matchId)
      .first<{ record_json: string }>();
    if (!row) return c.json({ message: "この棋譜は閲覧できません。" }, 404);
    const record = readRecord(row.record_json);
    if (!isShogiRecord(record)) return c.json({ message: "この棋譜は閲覧できません。" }, 404);
    if (query.data.cursor > record.replay.eventCount)
      return c.json({ message: "棋譜の取得条件が正しくありません。" }, 400);
    const page = await readShogiMatchReplayPage(c.env.APP_DB, record.id, query.data.cursor);
    if (!page) throw new Error("Archived replay missing");
    return c.json(getMatchReplayContract.response.parse({ matchId: record.id, ...page }));
  } catch {
    console.error("Match replay request failed");
    return c.json({ message: "棋譜を取得できませんでした。もう一度お試しください。" }, 503);
  }
});
