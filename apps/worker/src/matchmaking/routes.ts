import { Hono } from "hono";
import { z } from "zod";
import {
  matchmakingInputSchema,
  matchmakingControlSchema,
  matchmakingQueues,
  matchmakingStateSchema,
  type MatchmakingGame,
} from "@tetraboard/protocol";
import { accountIdentity } from "../accounts/auth";
import { roomEntryProfile, RoomAccountError } from "../accounts/roomAccounts";
import { readLimitedBody } from "../feedback/images";
import { aiServiceConfigured, shogiAiEnabled } from "../rooms/aiService";
import { readShogiRatingResult } from "../rooms/shogiRating";
export const matchmakingRoutes = new Hono<{ Bindings: Env }>();
export const matchmakingEnabled = (env: Env, game: MatchmakingGame = "four-reversi") =>
  game === "shogi"
    ? env.SHOGI_MATCHMAKING_ENABLED === "true" && shogiAiEnabled(env)
    : env.MATCHMAKING_ENABLED === "true" && aiServiceConfigured(env);
const gameSchema = z.enum(["four-reversi", "shogi"]);
const root = "/matchmaking/:game";
matchmakingRoutes.use("/matchmaking/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});
matchmakingRoutes.onError((error, c) =>
  c.json(
    {
      message:
        error instanceof RoomAccountError
          ? "参加情報を確認してください。"
          : "マッチングを処理できませんでした。再試行してください。",
    },
    error instanceof RoomAccountError ? error.status : 503,
  ),
);
matchmakingRoutes.get(root, async (c) => {
  const game = gameSchema.safeParse(c.req.param("game"));
  if (!game.success) return c.notFound();
  const enabled = matchmakingEnabled(c.env, game.data);
  const user = await accountIdentity(c.req.raw, c.env);
  if (!user || (game.data === "shogi" && user.isAnonymous))
    return c.json(
      matchmakingStateSchema.parse({
        status: "idle",
        serverNowMs: Date.now(),
        enabled,
      }),
    );
  const controller = z.uuid().optional().safeParse(c.req.query("controllerId"));
  if (!controller.success) return c.json({ message: "入力内容を確認してください。" }, 400);
  const state = await c.env.MATCHMAKING_COORDINATOR.getByName(
    matchmakingQueues[game.data].key,
  ).status(user.id, controller.data);
  return c.json(matchmakingStateSchema.parse({ ...state, enabled }));
});
matchmakingRoutes.get("/matchmaking/shogi/results/:matchId", async (c) => {
  const matchId = z.uuid().safeParse(c.req.param("matchId"));
  if (!matchId.success) return c.notFound();
  const user = await accountIdentity(c.req.raw, c.env);
  if (!user || user.isAnonymous) return c.json({ message: "ログインしてください。" }, 401);
  const result = await readShogiRatingResult(c.env.APP_DB, user.id, matchId.data);
  return result ? c.json(result) : c.notFound();
});
for (const action of ["join", "heartbeat", "cancel", "takeover"] as const)
  matchmakingRoutes.post(`${root}/${action}`, async (c) => {
    const game = gameSchema.safeParse(c.req.param("game"));
    if (!game.success) return c.notFound();
    if (c.req.header("Origin") !== c.env.APP_ORIGIN)
      return c.json({ message: "操作元を確認できません。" }, 403);
    const { user } = await roomEntryProfile(c.req.raw, c.env);
    if (!user) return c.json({ message: "参加情報を確認してください。" }, 401);
    if (game.data === "shogi" && user.isAnonymous)
      return c.json({ message: "将棋のレートマッチには登録アカウントが必要です。" }, 403);
    const enabled = matchmakingEnabled(c.env, game.data);
    if (action === "join" && !enabled)
      return c.json({ message: "ランダムマッチは準備中です。" }, 503);
    const bytes = await readLimitedBody(c.req.raw, 4096);
    let data: unknown;
    try {
      data = bytes ? JSON.parse(new TextDecoder().decode(bytes)) : null;
    } catch {
      data = null;
    }
    const parsed = (
      action === "join" ? matchmakingInputSchema : matchmakingControlSchema
    ).safeParse(data);
    if (!parsed.success) return c.json({ message: "入力内容を確認してください。" }, 400);
    const coordinator = c.env.MATCHMAKING_COORDINATOR.getByName(matchmakingQueues[game.data].key);
    const input = parsed.data;
    const result =
      action === "join"
        ? await coordinator.join(user.id, input.operationId, input.controllerId)
        : action === "takeover"
          ? await coordinator.takeover(
              user.id,
              input.operationId,
              input.controllerId,
              "version" in input ? Number(input.version) : 0,
            )
          : await coordinator.control(
              user.id,
              {
                ...input,
                version:
                  "version" in input && typeof input.version === "number" ? input.version : 0,
              },
              action,
            );
    return result.ok
      ? c.json(matchmakingStateSchema.parse({ ...result.state, enabled }))
      : c.json({ message: result.message }, 409);
  });
