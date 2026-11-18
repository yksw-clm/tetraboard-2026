import { readPublicMatches, readMatchDetail } from "@tetraboard/context-record";
import { D1MatchReadStore } from "../adapters/record/matchReadStore";
import { matchReadValidation } from "../adapters/record/readValidation";
import { Hono } from "hono";
import {
  listPublicMatchesContract,
  getPublicMatchContract,
  getPublicMatchReplayContract,
} from "@tetraboard/protocol";
import { participantProfiles } from "../adapters/record/matchProfiles";
import { readStoredMatch } from "../adapters/record/matchDataContracts";
import { readShogiMatchReplayPage } from "./shogiMatchStore";

export const publicMatchRoutes = new Hono<{ Bindings: Env }>();
publicMatchRoutes.get(listPublicMatchesContract.path, async (c) => {
  c.header("Cache-Control", "no-store");
  const query = listPublicMatchesContract.query.safeParse({
    game: c.req.query("game"),
    humanOnly: c.req.query("humanOnly"),
    includeMoveCount: c.req.query("includeMoveCount"),
    includeMatchKind: c.req.query("includeMatchKind"),
  });
  if (!query.success) return c.json({ message: "対局の取得条件が正しくありません。" }, 400);
  try {
    return c.json(
      listPublicMatchesContract.response.parse(
        await readPublicMatches(
          new D1MatchReadStore(c.env.APP_DB),
          query.data.game,
          query.data.humanOnly,
          readStoredMatch,
          (records) => participantProfiles(c.env.APP_DB, records),
          {
            includeMoveCount: query.data.includeMoveCount === "1",
            includeMatchKind: query.data.includeMatchKind === "1",
          },
        ),
      ),
    );
  } catch {
    console.error("Public match list request failed");
    return c.json({ message: "最近の対局を取得できませんでした。もう一度お試しください。" }, 503);
  }
});

publicMatchRoutes.get(getPublicMatchContract.path, async (c) => {
  c.header("Cache-Control", "no-store");
  const params = getPublicMatchContract.params.safeParse(c.req.param());
  const query = getPublicMatchContract.query.safeParse({
    includeMatchKind: c.req.query("includeMatchKind"),
  });
  if (!query.success) return c.json({ message: "棋譜の取得条件が正しくありません。" }, 400);
  if (!params.success) return c.json({ message: "棋譜のURLが正しくありません。" }, 400);
  try {
    const result = await readMatchDetail(
      new D1MatchReadStore(c.env.APP_DB),
      params.data.matchId,
      undefined,
      matchReadValidation,
      (records) => participantProfiles(c.env.APP_DB, records),
      query.data.includeMatchKind === "1",
    );
    if (!result) return c.json({ message: "この棋譜は閲覧できません。" }, 404);
    return c.json(getPublicMatchContract.response.parse(result));
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
    const row = await new D1MatchReadStore(c.env.APP_DB).readMatch(params.data.matchId);
    if (!row) return c.json({ message: "この棋譜は閲覧できません。" }, 404);
    const record = readStoredMatch(row.record_json, row.game);
    if (record.game !== "four-shogi" && record.game !== "shogi")
      return c.json({ message: "この棋譜は閲覧できません。" }, 404);
    if (query.data.cursor > record.record.replay.eventCount)
      return c.json({ message: "棋譜の取得条件が正しくありません。" }, 400);
    const page = await readShogiMatchReplayPage(
      c.env.APP_DB,
      record.record.id,
      query.data.cursor,
      record.game,
    );
    if (!page) throw new Error("Archived replay missing");
    return c.json(
      getPublicMatchReplayContract.response.parse({ matchId: record.record.id, ...page }),
    );
  } catch {
    console.error("Public match replay request failed");
    return c.json({ message: "棋譜を取得できませんでした。もう一度お試しください。" }, 503);
  }
});
