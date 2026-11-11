import { Hono } from "hono";
import { z } from "zod";
import {
  matchmakingInputSchema,
  matchmakingControlSchema,
  matchmakingQueues,
  matchmakingRules,
  matchmakingStateSchema,
  type MatchmakingGame,
  type MatchmakingState,
} from "@tetraboard/protocol";
import { accountIdentity } from "../accounts/auth";
import { roomEntryProfile, RoomAccountError } from "../accounts/roomAccounts";
import { readLimitedBody } from "../feedback/images";
import { gameCatalog } from "@tetraboard/protocol/games";
import { ratedMatchmakingPolicy } from "./ratedMatchmaking";
export const matchmakingRoutes = new Hono<{ Bindings: Env }>();
export const matchmakingEnabled = (env: Env, game: MatchmakingGame = "four-reversi") =>
  ratedMatchmakingPolicy(game).enabled(env);
const gameSchema = z.enum(["four-reversi", "four-shogi", "shogi", "reversi"]);
const root = "/matchmaking/:game";
function stateForClient(state: MatchmakingState, enabled: boolean, includeWaitingCount: boolean) {
  const { waitingCount, ...rest } = state;
  return matchmakingStateSchema.parse({
    ...rest,
    enabled,
    ...(includeWaitingCount && waitingCount !== undefined ? { waitingCount } : {}),
  });
}

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
  const legacy = game.data === "four-reversi" && c.req.query("rated") !== "1";
  const enabled = !legacy && matchmakingEnabled(c.env, game.data);
  const user = await accountIdentity(c.req.raw, c.env);
  const includeWaitingCount = c.req.query("waitingCount") === "1";
  const accountId = !user || (!legacy && user.isAnonymous) ? null : user.id;
  if (accountId === null && !(enabled && includeWaitingCount))
    return c.json(stateForClient({ status: "idle", serverNowMs: Date.now() }, enabled, false));
  const controller = z.uuid().optional().safeParse(c.req.query("controllerId"));
  if (!controller.success) return c.json({ message: "入力内容を確認してください。" }, 400);
  const state = await c.env.MATCHMAKING_COORDINATOR.getByName(
    legacy ? matchmakingRules.key : matchmakingQueues[game.data].key,
  ).status(accountId, controller.data, enabled && includeWaitingCount);
  return c.json(stateForClient(state, enabled, includeWaitingCount));
});
matchmakingRoutes.get(`${root}/rating`, async (c) => {
  const game = gameSchema.safeParse(c.req.param("game"));
  const policy = game.success ? ratedMatchmakingPolicy(game.data) : undefined;
  if (!policy) return c.notFound();
  const user = await accountIdentity(c.req.raw, c.env);
  if (!user || user.isAnonymous) return c.json({ message: "ログインしてください。" }, 401);
  const result = await policy.readSummary(c.env.APP_DB, user.id);
  return c.json(result);
});
matchmakingRoutes.get(`${root}/results/:matchId`, async (c) => {
  const game = gameSchema.safeParse(c.req.param("game"));
  const policy = game.success ? ratedMatchmakingPolicy(game.data) : undefined;
  const matchId = z.uuid().safeParse(c.req.param("matchId"));
  if (!policy || !matchId.success) return c.notFound();
  const user = await accountIdentity(c.req.raw, c.env);
  if (!user || user.isAnonymous) return c.json({ message: "ログインしてください。" }, 401);
  const result = await policy.readResult(
    c.env.APP_DB,
    user.id,
    matchId.data,
    c.req.query("includeOpponent") === "1",
  );
  return result ? c.json(result) : c.notFound();
});
for (const action of ["join", "heartbeat", "cancel", "takeover"] as const)
  matchmakingRoutes.post(`${root}/${action}`, async (c) => {
    const game = gameSchema.safeParse(c.req.param("game"));
    if (!game.success) return c.notFound();
    if (c.req.header("Origin") !== c.env.APP_ORIGIN)
      return c.json({ message: "操作元を確認できません。" }, 403);
    const legacy = game.data === "four-reversi" && c.req.query("rated") !== "1";
    const { user } = await roomEntryProfile(c.req.raw, c.env);
    if (!user) return c.json({ message: "参加情報を確認してください。" }, 401);
    if (!legacy && user.isAnonymous)
      return c.json(
        { message: `${gameCatalog[game.data].name}のレート戦には登録アカウントが必要です。` },
        403,
      );
    const enabled = !legacy && matchmakingEnabled(c.env, game.data);
    if (action === "join" && !enabled)
      return c.json({ message: "レート戦は現在受け付けていません。" }, 503);
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
    const coordinator = c.env.MATCHMAKING_COORDINATOR.getByName(
      legacy ? matchmakingRules.key : matchmakingQueues[game.data].key,
    );
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
      ? c.json(stateForClient(result.state, enabled, c.req.query("waitingCount") === "1"))
      : c.json({ message: result.message }, 409);
  });
