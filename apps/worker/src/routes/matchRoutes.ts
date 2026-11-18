import { readMatchHistory, readMatchDetail, readOwnMatchReplay } from "@tetraboard/context-record";
import { D1MatchReadStore } from "../adapters/record/matchReadStore";
import { matchReadValidation } from "../adapters/record/readValidation";
import { participantProfiles } from "../adapters/record/matchProfiles";
import { Hono } from "hono";
import {
  listMatchesContract,
  getMatchContract,
  getMatchReplayContract,
} from "@tetraboard/protocol";
import { accountIdentity } from "../accounts/auth";
import { readShogiMatchReplayPage } from "../rooms/shogiMatchStore";
import { readStoredMatch } from "../adapters/record/matchDataContracts";

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
      includeMoveCount: c.req.query("includeMoveCount"),
      includeMatchKind: c.req.query("includeMatchKind"),
      filter: c.req.query("filter"),
    });
    if (!query.success) return c.json({ message: "履歴の取得条件が正しくありません。" }, 400);
    const db = c.env.APP_DB;
    const { game, mode, cursor, filter, includeMoveCount, includeMatchKind } = query.data;
    const matches = await readMatchHistory(
      new D1MatchReadStore(db),
      { accountId: user.id, game, mode, cursor: cursor ?? null, filter },
      readStoredMatch,
      (records) => participantProfiles(db, records),
      { includeMoveCount: includeMoveCount === "1", includeMatchKind: includeMatchKind === "1" },
    );
    return c.json(listMatchesContract.response.parse(matches));
  } catch {
    console.error("Match history request failed");
    return c.json({ message: "対局履歴を取得できませんでした。もう一度お試しください。" }, 503);
  }
});

matchRoutes.get(getMatchContract.path, async (c) => {
  c.header("Cache-Control", "no-store");
  try {
    const user = await accountIdentity(c.req.raw, c.env);
    if (!user) return c.json({ message: "ログインしてください。" }, 401);
    const params = getMatchContract.params.safeParse(c.req.param());
    const query = getMatchContract.query.safeParse({
      includeMatchKind: c.req.query("includeMatchKind"),
    });
    if (!query.success) return c.json({ message: "棋譜の取得条件が正しくありません。" }, 400);
    if (!params.success) return c.json({ message: "棋譜のURLが正しくありません。" }, 400);
    const result = await readMatchDetail(
      new D1MatchReadStore(c.env.APP_DB),
      params.data.matchId,
      user.id,
      matchReadValidation,
      (records) => participantProfiles(c.env.APP_DB, records),
      query.data.includeMatchKind === "1",
    );
    if (!result) return c.json({ message: "この棋譜は閲覧できません。" }, 404);
    return c.json(getMatchContract.response.parse(result));
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
    const db = c.env.APP_DB;
    const result = await readOwnMatchReplay(
      new D1MatchReadStore(db),
      params.data.matchId,
      user.id,
      query.data.cursor,
      readStoredMatch,
      (id, cursor, game) => readShogiMatchReplayPage(db, id, cursor, game),
    );
    if (result.status === "not_found")
      return c.json({ message: "この棋譜は閲覧できません。" }, 404);
    if (result.status === "invalid_cursor")
      return c.json({ message: "棋譜の取得条件が正しくありません。" }, 400);
    return c.json(getMatchReplayContract.response.parse(result.page));
  } catch {
    console.error("Match replay request failed");
    return c.json({ message: "棋譜を取得できませんでした。もう一度お試しください。" }, 503);
  }
});
