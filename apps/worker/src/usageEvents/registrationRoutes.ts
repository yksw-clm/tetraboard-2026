import { registrationAnalyticsInputSchema } from "@tetraboard/protocol";
import { Hono } from "hono";
import { readLimitedBody } from "../feedback/images";
import { browserIdFromRequest } from "./browserId";
import { registrationUsage } from "./registration";

export const registrationEntryRoutes = new Hono<{ Bindings: Env }>();
registrationEntryRoutes.post("/analytics/registration", async (c) => {
  c.header("Cache-Control", "no-store");
  if (c.req.header("Origin") !== c.env.APP_ORIGIN)
    return c.json({ message: "操作元を確認できません。" }, 403);
  if (Number(c.req.header("Content-Length") ?? 0) > 8192) return c.body(null, 413);
  let body: unknown;
  try {
    const bytes = await readLimitedBody(c.req.raw, 8192);
    body = bytes ? JSON.parse(new TextDecoder().decode(bytes)) : null;
  } catch {
    return c.body(null, 400);
  }
  const input = registrationAnalyticsInputSchema.safeParse(body);
  if (!input.success) return c.body(null, 400);
  registrationUsage(c.env, input.data, browserIdFromRequest(c.req.raw)).write("entry");
  return c.body(null, 204);
});
