import { Hono } from "hono";
import {
  getPlayerGameRatingsContract,
  getPlayerProfileContract,
  listPlayerMatchesContract,
  ratedMatchmakingGameIds,
} from "@tetraboard/protocol";
import { readPlayerProfile, resolvePublicPlayer } from "@tetraboard/context-account";
import { readMatchHistory } from "@tetraboard/context-record";
import { playerProfilePorts } from "../adapters/account/playerProfile";
import { readGameRatingSummary } from "../adapters/matchmaking/ratedMatchmaking";
import { readStoredMatch } from "../adapters/record/matchDataContracts";
import { participantProfiles } from "../adapters/record/matchProfiles";
import { D1MatchReadStore } from "../adapters/record/matchReadStore";
export const playerProfileRoutes = new Hono<{ Bindings: Env }>();
playerProfileRoutes.get(getPlayerProfileContract.path, async (c) => {
  c.header("Cache-Control", "no-store");
  const query = getPlayerProfileContract.query.safeParse(c.req.query());
  if (!query.success)
    return c.json({ message: "プレイヤー情報の取得条件が正しくありません。" }, 400);
  try {
    const result = await readPlayerProfile(playerProfilePorts(c.env), query.data);
    if ("status" in result) return c.json({ message: result.message }, result.status);
    return c.json(getPlayerProfileContract.response.parse(result));
  } catch {
    console.error("Player profile request failed");
    return c.json({ message: "プレイヤー情報を取得できませんでした。" }, 503);
  }
});

playerProfileRoutes.get(getPlayerGameRatingsContract.path, async (c) => {
  c.header("Cache-Control", "no-store");
  const params = getPlayerGameRatingsContract.params.safeParse(c.req.param());
  if (!params.success) return c.json({ message: "レートの取得条件が正しくありません。" }, 400);
  try {
    const ports = playerProfilePorts(c.env);
    const { profileId } = params.data;
    const player = await resolvePublicPlayer(ports, profileId);
    if (!player) return c.json({ message: "プロフィールを表示できません。" }, 404);
    const games = player.profile.isAnonymous
      ? null
      : Object.fromEntries(
          await Promise.all(
            ratedMatchmakingGameIds.map(async (game) => [
              game,
              await readGameRatingSummary(c.env.APP_DB, game, player.accountId),
            ]),
          ),
        );
    const current = await resolvePublicPlayer(ports, profileId);
    if (
      current?.accountId !== player.accountId ||
      current.profileId !== player.profileId ||
      current.profile.isAnonymous !== player.profile.isAnonymous
    )
      return c.json({ message: "プロフィールを表示できません。" }, 404);
    return c.json(
      getPlayerGameRatingsContract.response.parse({ profileId: current.profileId, games }),
    );
  } catch {
    console.error("Player game ratings request failed");
    return c.json({ message: "レートを取得できませんでした。" }, 503);
  }
});

playerProfileRoutes.get(listPlayerMatchesContract.path, async (c) => {
  c.header("Cache-Control", "no-store");
  const params = listPlayerMatchesContract.params.safeParse(c.req.param());
  const query = listPlayerMatchesContract.query.safeParse(c.req.query());
  if (!params.success || !query.success)
    return c.json({ message: "棋譜の取得条件が正しくありません。" }, 400);
  try {
    const ports = playerProfilePorts(c.env);
    const { profileId } = params.data;
    const player = await resolvePublicPlayer(ports, profileId);
    if (!player) return c.json({ message: "プロフィールを表示できません。" }, 404);
    const db = c.env.APP_DB;
    const { matches } = await readMatchHistory(
      new D1MatchReadStore(db),
      { accountId: player.accountId, ...query.data, cursor: null, filter: "all" },
      readStoredMatch,
      (records) => participantProfiles(db, records),
      { includeMoveCount: true, includeMatchKind: true },
    );
    const current = await resolvePublicPlayer(ports, profileId);
    if (current?.accountId !== player.accountId || current.profileId !== player.profileId)
      return c.json({ message: "プロフィールを表示できません。" }, 404);
    return c.json(listPlayerMatchesContract.response.parse({ matches }));
  } catch {
    console.error("Player matches request failed");
    return c.json({ message: "棋譜を取得できませんでした。もう一度お試しください。" }, 503);
  }
});
