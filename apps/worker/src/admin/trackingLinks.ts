import { Hono } from "hono";
import {
  trackingLinkInputSchema,
  trackingLinkUpdateSchema,
  trackingLinkSchema,
  trackingLinksSchema,
} from "@tetraboard/protocol";
import { adminIdentity, type AdminEnv } from "./auth";
import { readLimitedBody } from "../feedback/images";
export const trackingLinkRoutes = new Hono<{ Bindings: AdminEnv }>();
for (const path of ["/admin/tracking-links", "/admin/tracking-links/*"]) {
  trackingLinkRoutes.use(path, async (c, next) => {
    c.header("Cache-Control", "no-store");
    const identity = await adminIdentity(c.req.raw, c.env);
    if (identity.status !== 200) return c.json({ message: identity.message }, identity.status);
    if (c.req.method !== "GET" && c.req.header("Origin") !== c.env.APP_ORIGIN)
      return c.json({ message: "操作元を確認できません。" }, 403);
    await next();
  });
}
trackingLinkRoutes.onError((_error, c) =>
  c.json({ message: "計測リンクを処理できません。再試行してください。" }, 503),
);
type LinkRow = {
  id: number;
  label: string;
  medium: string;
  campaign: string;
  archived: number;
  created_at_ms: number;
};
const toLink = (row: LinkRow) =>
  trackingLinkSchema.parse({
    id: row.id,
    label: row.label,
    medium: row.medium,
    campaign: row.campaign,
    archived: Boolean(row.archived),
    createdAtMs: row.created_at_ms,
  });
trackingLinkRoutes.get("/admin/tracking-links", async (c) => {
  const raw = c.req.query("after") ?? "0",
    after = Number(raw);
  if (!/^\d{1,16}$/.test(raw) || !Number.isSafeInteger(after) || after < 0)
    return c.json({ message: "続きの指定が正しくありません。" }, 400);
  const rows = (
    await c.env.APP_DB.prepare("SELECT * FROM analytics_links WHERE id>? ORDER BY id LIMIT 51")
      .bind(after)
      .all<LinkRow>()
  ).results;
  return c.json(
    trackingLinksSchema.parse({
      links: rows.slice(0, 50).map(toLink),
      nextCursor: rows.length > 50 ? rows[49]!.id : null,
    }),
  );
});
async function json(request: Request) {
  const bytes = await readLimitedBody(request, 8192);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}
trackingLinkRoutes.post("/admin/tracking-links", async (c) => {
  const input = trackingLinkInputSchema.safeParse(await json(c.req.raw));
  if (!input.success) return c.json({ message: "表示名・媒体・施策名を確認してください。" }, 400);
  const row = await c.env.APP_DB.prepare(
    "INSERT INTO analytics_links(label,medium,campaign,created_at_ms) VALUES(?,?,?,?) RETURNING *",
  )
    .bind(input.data.label, input.data.medium, input.data.campaign, Date.now())
    .first<LinkRow>();
  return c.json(toLink(row!), 201);
});
trackingLinkRoutes.patch("/admin/tracking-links/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!/^[1-9][0-9]{0,15}$/.test(c.req.param("id")) || !Number.isSafeInteger(id))
    return c.json({ message: "番号の指定が正しくありません。" }, 400);
  const input = trackingLinkUpdateSchema.safeParse(await json(c.req.raw));
  if (!input.success) return c.json({ message: "変更できるのは表示名とアーカイブ状態です。" }, 400);
  if (id <= 4 && input.data.label !== undefined)
    return c.json({ message: "固定リンクの表示名は変更できません。" }, 400);
  const row = await c.env.APP_DB.prepare(
    "UPDATE analytics_links SET label=COALESCE(?,label),archived=COALESCE(?,archived) WHERE id=? RETURNING *",
  )
    .bind(
      input.data.label ?? null,
      input.data.archived === undefined ? null : Number(input.data.archived),
      id,
    )
    .first<LinkRow>();
  if (!row) return c.json({ message: "計測リンクが見つかりません。" }, 404);
  return c.json(toLink(row));
});
