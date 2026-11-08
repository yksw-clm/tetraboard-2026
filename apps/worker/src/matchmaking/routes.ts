import { Hono } from "hono";
import { z } from "zod";
import {
  matchmakingInputSchema,
  matchmakingControlSchema,
  matchmakingRules,
  matchmakingStateSchema,
} from "@tetraboard/protocol";
import { accountIdentity } from "../accounts/auth";
import { roomEntryProfile, RoomAccountError } from "../accounts/roomAccounts";
import { readLimitedBody } from "../feedback/images";
import { aiServiceConfigured } from "../rooms/aiService";
export const matchmakingRoutes = new Hono<{ Bindings: Env }>();
const root = "/matchmaking/four-reversi";
export const matchmakingEnabled = (env: Env) =>
  env.MATCHMAKING_ENABLED === "true" && aiServiceConfigured(env);
matchmakingRoutes.use(`${root}*`, async (c, next) => {
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
  const user = await accountIdentity(c.req.raw, c.env);
  if (!user)
    return c.json(
      matchmakingStateSchema.parse({
        status: "idle",
        serverNowMs: Date.now(),
        enabled: matchmakingEnabled(c.env),
      }),
    );
  const controller = z.uuid().optional().safeParse(c.req.query("controllerId"));
  if (!controller.success) return c.json({ message: "入力内容を確認してください。" }, 400);
  const state = await c.env.MATCHMAKING_COORDINATOR.getByName(matchmakingRules.key).status(
    user.id,
    controller.data,
  );
  return c.json(matchmakingStateSchema.parse({ ...state, enabled: matchmakingEnabled(c.env) }));
});
for (const action of ["join", "heartbeat", "cancel", "takeover"] as const)
  matchmakingRoutes.post(`${root}/${action}`, async (c) => {
    if (c.req.header("Origin") !== c.env.APP_ORIGIN)
      return c.json({ message: "操作元を確認できません。" }, 403);
    const { user } = await roomEntryProfile(c.req.raw, c.env);
    if (!user) return c.json({ message: "参加情報を確認してください。" }, 401);
    if (action === "join" && !matchmakingEnabled(c.env))
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
    const coordinator = c.env.MATCHMAKING_COORDINATOR.getByName(matchmakingRules.key);
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
      ? c.json(
          matchmakingStateSchema.parse({ ...result.state, enabled: matchmakingEnabled(c.env) }),
        )
      : c.json({ message: result.message }, 409);
  });
