import { Hono } from "hono";
import { z } from "zod";
import { gameIds } from "@tetraboard/protocol/games";
import { browserIdFromRequest } from "./browserId";
import { readBody } from "./readBody";
import { isBrowserUserAgent } from "./visit";
import { createUsageEventWriter } from "./writer";

const inputSchema = z.strictObject({ game: z.enum(gameIds) });

export const boardPreviewViewRoutes = new Hono<{ Bindings: Env }>();
boardPreviewViewRoutes.post("/board-preview-views", async (c) => {
  c.header("Cache-Control", "no-store");
  if (c.req.header("Origin") !== c.env.APP_ORIGIN)
    return c.json({ message: "操作元を確認できません。" }, 403);
  const input = inputSchema.safeParse(await readBody(c.req.raw, 256));
  if (!input.success) return c.body(null, 400);

  const browserId = browserIdFromRequest(c.req.raw);
  if (!isBrowserUserAgent(c.req.raw.headers.get("User-Agent")) || !browserId)
    return c.body(null, 204);

  createUsageEventWriter(c.env.USAGE_EVENTS).write({
    name: "board_preview_viewed",
    isTest: false,
    game: input.data.game,
    browserId,
    accountId: "",
  });
  return c.body(null, 204);
});
