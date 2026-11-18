import { readPublicMatches } from "@tetraboard/context-record";
import { D1MatchReadStore } from "../adapters/record/matchReadStore";
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
import { ratedMatchmakingPolicy } from "../adapters/matchmaking/ratedMatchmaking";
import { listGeneralRooms, listLobbyRoomCards } from "../rooms/roomIndex";
import { participantProfiles } from "../adapters/record/matchProfiles";
import { readStoredMatch } from "../adapters/record/matchDataContracts";
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
  return c.json(
    lobbyMatchesSchema.parse(
      await readPublicMatches(
        new D1MatchReadStore(c.env.APP_DB),
        undefined,
        query.data.humanOnly === "true",
        readStoredMatch,
        (records) => participantProfiles(c.env.APP_DB, records),
        {
          includeMoveCount: query.data.includeMoveCount === "1",
          includeMatchKind: query.data.includeMatchKind === "1",
        },
      ),
    ),
  );
});
