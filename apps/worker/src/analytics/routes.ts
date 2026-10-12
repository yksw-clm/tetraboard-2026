import { analyticsRetentionMs } from "@tetraboard/protocol/privacy";
import { Hono } from "hono";
import { pageViewInputSchema, dwellInputSchema } from "@tetraboard/protocol";
import { accountIdentity } from "../accounts/auth";
import { analyticsVisitor, coverageStatement } from "./store";

export const analyticsRoutes = new Hono<{ Bindings: Env }>();
analyticsRoutes.use("/analytics/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  if (c.req.header("Origin") !== c.env.APP_ORIGIN)
    return c.json({ message: "操作元を確認できません。" }, 403);
  if (Number(c.req.header("Content-Length") ?? 0) > 8192) return c.body(null, 413);
  await next();
});
analyticsRoutes.onError((_error, c) => c.json({ message: "計測を保存できません。" }, 503));
async function body(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) return null;
  let length = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    length += result.value.length;
    if (length > 8192) {
      await reader.cancel();
      return null;
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}
analyticsRoutes.post("/analytics/pageviews", async (c) => {
  const input = pageViewInputSchema.safeParse(await body(c.req.raw));
  if (!input.success) return c.body(null, 400);
  const visitor = analyticsVisitor(c.req.raw);
  if (!visitor) return c.body(null, 204);
  const user = await accountIdentity(c.req.raw, c.env);
  const now = Date.now();
  // 1ブラウザの異常な送信で、ページビュー行が際限なく増えることを防ぎます。
  const recent = await c.env.APP_DB.prepare(
    "SELECT COUNT(*) AS count FROM analytics_pageviews WHERE visitor_id = ? AND started_at_ms > ?",
  )
    .bind(visitor, now - 60000)
    .first<{ count: number }>();
  if ((recent?.count ?? 0) >= 120) return c.body(null, 429);
  await c.env.APP_DB.batch([
    coverageStatement(c.env.APP_DB, now),
    c.env.APP_DB.prepare(`INSERT INTO analytics_pageviews (id, visitor_id, account_id, is_test, page, game, started_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`).bind(
      input.data.id,
      visitor,
      user?.id ?? null,
      Number(Boolean(user?.isTestUser)),
      input.data.page,
      input.data.game,
      now,
    ),
  ]);
  return c.body(null, 204);
});
analyticsRoutes.post("/analytics/dwell", async (c) => {
  const input = dwellInputSchema.safeParse(await body(c.req.raw));
  if (!input.success) return c.body(null, 400);
  const visitor = analyticsVisitor(c.req.raw);
  if (!visitor) return c.body(null, 204);
  const view = await c.env.APP_DB.prepare(
    "SELECT started_at_ms FROM analytics_pageviews WHERE id = ? AND visitor_id = ?",
  )
    .bind(input.data.id, visitor)
    .first<{ started_at_ms: number }>();
  if (!view || view.started_at_ms <= Date.now() - analyticsRetentionMs) return c.body(null, 404);
  const now = Date.now();
  const entries = input.data.days;
  for (const entry of entries) {
    const start = Date.parse(`${entry.day}T00:00:00+09:00`);
    const maximum = Math.max(
      0,
      Math.min(start + 86400000, now) - Math.max(start, view.started_at_ms),
    );
    if (entry.milliseconds > maximum + 2000) return c.body(null, 400);
  }
  await c.env.APP_DB.batch(
    entries.map((entry) =>
      c.env.APP_DB.prepare(`INSERT INTO analytics_dwell (view_id, day, milliseconds) VALUES (?, ?, ?)
    ON CONFLICT(view_id, day) DO UPDATE SET milliseconds = MAX(milliseconds, excluded.milliseconds)`).bind(
        input.data.id,
        entry.day,
        entry.milliseconds,
      ),
    ),
  );
  return c.body(null, 204);
});
