import { readMatchHistory, readMatchDetail } from "@tetraboard/context-record";
import { D1MatchReadStore } from "../adapters/record/matchReadStore";
import { matchReadValidation } from "../adapters/record/readValidation";
import { participantProfiles } from "./matchProfiles";
import { defaultGameId } from "@tetraboard/protocol/games";
import { Hono } from "hono";
import {
  listMatchesContract,
  getMatchContract,
  getMatchReplayContract,
  type RoomMode,
  type MatchGame,
  type MatchHistoryFilter,
} from "@tetraboard/protocol";
import { accountIdentity } from "./auth";
import { readShogiMatchReplayPage } from "../rooms/shogiMatchStore";
import { readStoredMatch } from "./matchDataContracts";

export async function listMatches(
  db: D1Database,
  accountId: string,
  mode: RoomMode | undefined,
  cursor: { startedAtMs: number; id: string } | null,
  game: MatchGame = defaultGameId,
  includeMoveCount = false,
  includeMatchKind = false,
  filter: MatchHistoryFilter = "all",
) {
  return listMatchesContract.response.parse(
    await readMatchHistory(
      new D1MatchReadStore(db),
      { accountId, game, mode, cursor, filter },
      readStoredMatch,
      (records) => participantProfiles(db, records),
      { includeMoveCount, includeMatchKind },
    ),
  );
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
      includeMoveCount: c.req.query("includeMoveCount"),
      includeMatchKind: c.req.query("includeMatchKind"),
      filter: c.req.query("filter"),
    });
    if (!query.success) return c.json({ message: "履歴の取得条件が正しくありません。" }, 400);
    return c.json(
      await listMatches(
        c.env.APP_DB,
        user.id,
        query.data.mode,
        query.data.cursor ?? null,
        query.data.game,
        query.data.includeMoveCount === "1",
        query.data.includeMatchKind === "1",
        query.data.filter,
      ),
    );
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
    const row = await new D1MatchReadStore(c.env.APP_DB).readMatch(params.data.matchId, user.id);
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
    return c.json(getMatchReplayContract.response.parse({ matchId: record.record.id, ...page }));
  } catch {
    console.error("Match replay request failed");
    return c.json({ message: "棋譜を取得できませんでした。もう一度お試しください。" }, 503);
  }
});
