import { readMatchKinds, withMatchKind } from "../accounts/matchKinds";
import { Hono } from "hono";
import { z } from "zod";
import {
  lobbyRoomsQuerySchema,
  lobbyRoomsSchema,
  lobbyRoomCardsSchema,
  lobbyMatchesSchema,
  lobbyGameRatingsSchema,
} from "@tetraboard/protocol/general-lobby";
import { ratedMatchmakingGameIds } from "@tetraboard/protocol";
import { accountIdentity } from "../accounts/auth";
import { ratedMatchmakingPolicy } from "../matchmaking/ratedMatchmaking";
import { listGeneralRooms, listLobbyRoomCards } from "../rooms/roomIndex";
import { participantProfiles } from "../accounts/matchProfiles";
import { readStoredMatch, matchSummary } from "../accounts/matchDataContracts";
export const generalLobbyRoutes = new Hono<{ Bindings: Env }>();
generalLobbyRoutes.use("/lobby/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});
generalLobbyRoutes.onError((_error, c) =>
  c.json({ message: "一覧を取得できませんでした。もう一度お試しください。" }, 503),
);
generalLobbyRoutes.get("/lobby/game-ratings", async (c) => {
  const user = await accountIdentity(c.req.raw, c.env);
  const registered = user && !user.isAnonymous ? user : null;
  const entries = await Promise.all(
    ratedMatchmakingGameIds.map(async (game) => {
      const policy = ratedMatchmakingPolicy(game);
      const enabled = policy.enabled(c.env);
      if (!registered) return [game, { enabled, summary: null }];
      try {
        const summary = await policy.readSummary(c.env.APP_DB, registered.id);
        return [
          game,
          {
            enabled,
            summary:
              summary.status === "rated"
                ? { status: "rated", rating: Math.round(summary.rating) }
                : { status: "placement", games: summary.games },
          },
        ];
      } catch {
        return [game, { enabled, summary: { status: "error" } }];
      }
    }),
  );
  return c.json(
    lobbyGameRatingsSchema.parse({
      viewer: registered
        ? { profileId: registered.publicProfileId ?? null, username: registered.username }
        : null,
      games: Object.fromEntries(entries),
    }),
  );
});
generalLobbyRoutes.get("/lobby/rooms", async (c) => {
  const query = lobbyRoomsQuerySchema.safeParse(c.req.query());
  if (!query.success) return c.json({ message: "取得条件が正しくありません。" }, 400);
  if (query.data.view === "cards") {
    return c.json(lobbyRoomCardsSchema.parse(await listLobbyRoomCards(c.env, query.data)));
  }
  return c.json(
    lobbyRoomsSchema.parse(
      await listGeneralRooms(c.env.APP_DB, query.data.capacity, query.data.cursor),
    ),
  );
});
generalLobbyRoutes.get("/lobby/matches", async (c) => {
  const query = z
    .strictObject({
      humanOnly: z.enum(["true", "false"]).default("false"),
      includeMoveCount: z.literal("1").optional(),
      includeMatchKind: z.literal("1").optional(),
    })
    .safeParse(c.req.query());
  if (!query.success) return c.json({ message: "取得条件が正しくありません。" }, 400);
  const rows = await c.env.APP_DB.prepare(`SELECT game,record_json FROM matches
 ${
   query.data.humanOnly === "true"
     ? `WHERE json_array_length(record_json,'$.participants')=CASE WHEN game IN ('reversi','shogi','gomoku') THEN 2 ELSE 4 END
 AND NOT EXISTS(SELECT 1 FROM json_each(record_json,'$.participants') p WHERE json_extract(p.value,'$.kind') IS NOT 'human')`
     : ""
 }
 ORDER BY started_at_ms DESC,id DESC LIMIT 20`).all<{ game: string; record_json: string }>();
  const records = rows.results.map((row) => readStoredMatch(row.record_json, row.game));
  const profiles = await participantProfiles(c.env.APP_DB, records);
  const kinds =
    query.data.includeMatchKind === "1" ? await readMatchKinds(c.env.APP_DB, records) : undefined;
  return c.json(
    lobbyMatchesSchema.parse({
      matches: records.map((record) =>
        withMatchKind(matchSummary(record, profiles, query.data.includeMoveCount === "1"), kinds),
      ),
    }),
  );
});
