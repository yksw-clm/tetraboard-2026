import { Hono } from "hono";
import { z } from "zod";
import { browserIdFromRequest } from "./browserId";
import { createUsageEventWriter } from "./writer";

const inputSchema = z.strictObject({
  page: z.enum(["general-lobby", "lobby", "room", "replay", "setup", "login", "account", "other"]),
  kind: z.string().refine((value) => Array.from(value).length <= 100),
  message: z.string().refine((value) => Array.from(value).length <= 200),
});

async function readBody(request: Request): Promise<unknown> {
  if (Number(request.headers.get("Content-Length") ?? 0) > 2048) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const bytes = new Uint8Array(2048);
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (length + chunk.value.length > bytes.length) {
        await reader.cancel();
        return null;
      }
      bytes.set(chunk.value, length);
      length += chunk.value.length;
    }
    return JSON.parse(new TextDecoder().decode(bytes.subarray(0, length)));
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

export const clientErrorRoutes = new Hono<{ Bindings: Env }>();
clientErrorRoutes.post("/client-errors", async (c) => {
  c.header("Cache-Control", "no-store");
  if (c.req.header("Origin") !== c.env.APP_ORIGIN)
    return c.json({ message: "操作元を確認できません。" }, 403);
  const input = inputSchema.safeParse(await readBody(c.req.raw));
  if (!input.success) return c.body(null, 400);
  createUsageEventWriter(c.env.USAGE_EVENTS).write({
    name: "client_error",
    isTest: false,
    browserId: browserIdFromRequest(c.req.raw),
    page: input.data.page,
    kind: input.data.kind,
    message: input.data.message.replace(
      /(?:[a-z][a-z\d+.-]*:)?\/\/[^\s"'<>`]+/gi,
      (url) => url.split(/[?#]/)[0]!,
    ),
  });
  return c.body(null, 204);
});
