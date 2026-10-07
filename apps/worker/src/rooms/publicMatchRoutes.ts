import { Hono } from "hono";
import {
  listPublicMatchesContract,
  getPublicMatchContract,
  getPublicMatchReplayContract,
} from "@tetraboard/protocol";
import { participantProfiles } from "../accounts/matchProfiles";
import { readStoredMatch, matchSummary, publicMatchDetail } from "../accounts/matchDataContracts";
import { readShogiMatchReplayPage } from "./shogiMatchStore";

export const publicMatchRoutes = new Hono<{ Bindings: Env }>();
publicMatchRoutes.get(listPublicMatchesContract.path, async (c) => {
  c.header("Cache-Control", "no-store");
  const query = listPublicMatchesContract.query.safeParse({
    game: c.req.query("game"),
    humanOnly: c.req.query("humanOnly"),
  });
  if (!query.success) return c.json({ message: "対局の取得条件が正しくありません。" }, 400);
  try {
    const humanFilter = query.data.humanOnly
      ? `AND json_array_length(record_json, '$.participants') = 4
         AND NOT EXISTS (
           SELECT 1 FROM json_each(record_json, '$.participants') participant
           WHERE json_extract(participant.value, '$.kind') IS NOT 'human'
         )`
      : "";
    const rows = await c.env.APP_DB.prepare(`SELECT game, record_json FROM matches
      WHERE game = ? ${humanFilter} ORDER BY started_at_ms DESC, id DESC LIMIT 20`)
      .bind(query.data.game)
      .all<{ game: string; record_json: string }>();
    const records = rows.results.map((row) => readStoredMatch(row.record_json, row.game));
    const profiles = await participantProfiles(c.env.APP_DB, records);
    return c.json(
      listPublicMatchesContract.response.parse({
        matches: records.map((record) => matchSummary(record, profiles)),
      }),
    );
  } catch {
    console.error("Public match list request failed");
    return c.json({ message: "最近の対局を取得できませんでした。もう一度お試しください。" }, 503);
  }
});

publicMatchRoutes.get(getPublicMatchContract.path, async (c) => {
  c.header("Cache-Control", "no-store");
  const params = getPublicMatchContract.params.safeParse(c.req.param());
  if (!params.success) return c.json({ message: "棋譜のURLが正しくありません。" }, 400);
  try {
    const row = await c.env.APP_DB.prepare("SELECT game, record_json FROM matches WHERE id = ?")
      .bind(params.data.matchId)
      .first<{ game: string; record_json: string }>();
    if (!row) return c.json({ message: "この棋譜は閲覧できません。" }, 404);
    const record = readStoredMatch(row.record_json, row.game);
    const profiles = await participantProfiles(c.env.APP_DB, [record]);
    return c.json(
      getPublicMatchContract.response.parse({ match: publicMatchDetail(record, profiles) }),
    );
  } catch {
    console.error("Public match detail request failed");
    return c.json({ message: "棋譜を取得できませんでした。もう一度お試しください。" }, 503);
  }
});

publicMatchRoutes.get(getPublicMatchReplayContract.path, async (c) => {
  c.header("Cache-Control", "no-store");
  const params = getPublicMatchReplayContract.params.safeParse(c.req.param());
  const query = getPublicMatchReplayContract.query.safeParse({ cursor: c.req.query("cursor") });
  if (!params.success || !query.success)
    return c.json({ message: "棋譜の取得条件が正しくありません。" }, 400);
  try {
    const row = await c.env.APP_DB.prepare("SELECT game, record_json FROM matches WHERE id = ?")
      .bind(params.data.matchId)
      .first<{ game: string; record_json: string }>();
    if (!row) return c.json({ message: "この棋譜は閲覧できません。" }, 404);
    const record = readStoredMatch(row.record_json, row.game);
    if (record.game !== "four-shogi") return c.json({ message: "この棋譜は閲覧できません。" }, 404);
    if (query.data.cursor > record.record.replay.eventCount)
      return c.json({ message: "棋譜の取得条件が正しくありません。" }, 400);
    const page = await readShogiMatchReplayPage(c.env.APP_DB, record.record.id, query.data.cursor);
    if (!page) throw new Error("Archived replay missing");
    return c.json(
      getPublicMatchReplayContract.response.parse({ matchId: record.record.id, ...page }),
    );
  } catch {
    console.error("Public match replay request failed");
    return c.json({ message: "棋譜を取得できませんでした。もう一度お試しください。" }, 503);
  }
});
