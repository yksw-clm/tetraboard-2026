import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import {
  announcementDateSchema,
  announcementIdSchema,
  announcementInputSchema,
  announcementPatchSchema,
  gameIdSchema,
} from "@tetraboard/protocol";
import { adminIdentity, type AdminEnv } from "../admin/auth";
import { readLimitedBody } from "../feedback/images";
import { columns, create, detail, read, record, summary, update, type Row } from "./store";

type Bindings = AdminEnv;
export const announcementRoutes = new Hono<{ Bindings: Bindings }>();
export const announcementAdminRoutes = new Hono<{ Bindings: Bindings }>();
const noStore: MiddlewareHandler<{ Bindings: Bindings }> = async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
};
announcementRoutes.use("/announcements", noStore);
announcementRoutes.use("/announcements/*", noStore);
announcementAdminRoutes.use("/admin/announcements", noStore);
announcementAdminRoutes.use("/admin/announcements/*", noStore);
const protect: MiddlewareHandler<{ Bindings: Bindings }> = async (c, next) => {
  if (!["GET", "HEAD"].includes(c.req.method) && c.req.header("Origin") !== c.env.APP_ORIGIN)
    return c.json({ message: "操作元を確認できません。" }, 403);
  const identity = await adminIdentity(c.req.raw, c.env);
  if (identity.status !== 200) return c.json({ message: identity.message }, identity.status);
  await next();
};
announcementAdminRoutes.use("/admin/announcements", protect);
announcementAdminRoutes.use("/admin/announcements/*", protect);
for (const routes of [announcementRoutes, announcementAdminRoutes]) {
  routes.onError((_error, c) =>
    c.json({ message: "処理できませんでした。時間をおいて再試行してください。" }, 503),
  );
}
const cursorSchema = z
  .object({
    date: announcementDateSchema,
    at: z.number().int().nonnegative(),
    id: announcementIdSchema,
  })
  .strict();
const querySchema = z.object({ cursor: z.string().max(512).optional() });
async function list(db: D1Database, cursor: string | undefined, publicOnly: boolean) {
  let after: z.infer<typeof cursorSchema> | undefined;
  if (cursor !== undefined) {
    try {
      after = cursorSchema.parse(JSON.parse(atob(cursor)));
    } catch {
      return null;
    }
  }
  const limit = publicOnly ? 20 : 50;
  const conditions = [publicOnly ? "a.published = 1" : "1 = 1"];
  if (after) conditions.push("(a.date, a.created_at_ms, a.id) < (?, ?, ?)");
  const statement = db.prepare(
    `SELECT ${columns} FROM announcements a WHERE ${conditions.join(" AND ")} ORDER BY a.date DESC, a.created_at_ms DESC, a.id DESC LIMIT ?`,
  );
  const rows = await statement
    .bind(...(after ? [after.date, after.at, after.id] : []), limit + 1)
    .all<Row>();
  const page = rows.results.slice(0, limit);
  const last = page.at(-1);
  return {
    announcements: page.map((row) => (publicOnly ? summary(row) : record(row))),
    nextCursor:
      rows.results.length > limit && last
        ? btoa(JSON.stringify({ date: last.date, at: last.created_at_ms, id: last.id }))
        : null,
  };
}
announcementRoutes.get("/announcements", async (c) => {
  const query = querySchema.safeParse(c.req.query());
  const page = query.success ? await list(c.env.APP_DB, query.data.cursor, true) : null;
  return page ? c.json(page) : c.json({ message: "検索条件が正しくありません。" }, 400);
});
announcementRoutes.get("/announcements/lobby", async (c) => {
  const game = gameIdSchema.safeParse(c.req.query("game"));
  if (!game.success) return c.json({ message: "ゲームを確認してください。" }, 400);
  const row = await c.env.APP_DB.prepare(
    `SELECT ${columns} FROM announcements a WHERE a.published = 1 AND EXISTS (SELECT 1 FROM announcement_lobby_targets WHERE announcement_id = a.id AND game = ?) ORDER BY a.date DESC, a.created_at_ms DESC, a.id DESC LIMIT 1`,
  )
    .bind(game.data)
    .first<Row>();
  return c.json({ announcement: row ? summary(row) : null });
});
announcementRoutes.get("/announcements/:id", async (c) => {
  if (!announcementIdSchema.safeParse(c.req.param("id")).success) return c.notFound();
  const row = await read(c.env.APP_DB, c.req.param("id"), true);
  return row ? c.json(detail(row)) : c.notFound();
});
announcementAdminRoutes.get("/admin/announcements", async (c) => {
  const query = querySchema.safeParse(c.req.query());
  const page = query.success ? await list(c.env.APP_DB, query.data.cursor, false) : null;
  return page ? c.json(page) : c.json({ message: "検索条件が正しくありません。" }, 400);
});
announcementAdminRoutes.get("/admin/announcements/:id", async (c) => {
  const row = await read(c.env.APP_DB, c.req.param("id"));
  return row ? c.json(record(row)) : c.notFound();
});
async function json(request: Request) {
  const bytes = await readLimitedBody(request, 32768);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}
announcementAdminRoutes.post("/admin/announcements", async (c) => {
  const input = announcementInputSchema.safeParse(await json(c.req.raw));
  if (!input.success) return c.json({ message: "入力内容を確認してください。" }, 400);
  const id = await create(c.env.APP_DB, input.data);
  const row = await read(c.env.APP_DB, id);
  if (!row) throw new Error("Saved announcement missing");
  return c.json(record(row), 201);
});
announcementAdminRoutes.patch("/admin/announcements/:id", async (c) => {
  const input = announcementPatchSchema.safeParse(await json(c.req.raw));
  if (!input.success) return c.json({ message: "入力内容を確認してください。" }, 400);
  const id = c.req.param("id");
  if (!(await read(c.env.APP_DB, id))) return c.notFound();
  if (!(await update(c.env.APP_DB, id, input.data, input.data.version)))
    return c.json({ message: "別の操作で更新されました。最新データを読み直してください。" }, 409);
  const row = await read(c.env.APP_DB, id);
  if (!row) throw new Error("Saved announcement missing");
  return c.json(record(row));
});
