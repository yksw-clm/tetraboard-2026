import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import {
  announcementDateSchema,
  announcementFirstLine,
  announcementIdSchema,
  announcementInputSchema,
  announcementPatchSchema,
  gameIdSchema,
} from "@tetraboard/protocol";
import { adminIdentity, type AdminEnv } from "../admin/auth";
import { readLimitedBody } from "./readLimitedBody";
import { announcementStore } from "../adapters/community/announcements";
import {
  createAnnouncement,
  listAnnouncements,
  readAnnouncement,
  readLobbyAnnouncement,
  updateAnnouncement,
  type AnnouncementScope,
} from "@tetraboard/context-community";

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
async function list(db: D1Database, cursor: string | undefined, scope: AnnouncementScope) {
  let after: z.infer<typeof cursorSchema> | undefined;
  if (cursor !== undefined) {
    try {
      after = cursorSchema.parse(JSON.parse(atob(cursor)));
    } catch {
      return null;
    }
  }
  const page = await listAnnouncements(announcementStore(db), scope, after, announcementFirstLine);
  return {
    ...page,
    nextCursor: page.nextCursor ? btoa(JSON.stringify(page.nextCursor)) : null,
  };
}
announcementRoutes.get("/announcements", async (c) => {
  const query = querySchema.safeParse(c.req.query());
  const page = query.success ? await list(c.env.APP_DB, query.data.cursor, "public") : null;
  return page ? c.json(page) : c.json({ message: "検索条件が正しくありません。" }, 400);
});
announcementRoutes.get("/announcements/lobby", async (c) => {
  const game = gameIdSchema.safeParse(c.req.query("game"));
  if (!game.success) return c.json({ message: "ゲームを確認してください。" }, 400);
  const announcement = await readLobbyAnnouncement(
    announcementStore(c.env.APP_DB),
    game.data,
    announcementFirstLine,
  );
  return c.json({ announcement });
});
announcementRoutes.get("/announcements/:id", async (c) => {
  if (!announcementIdSchema.safeParse(c.req.param("id")).success) return c.notFound();
  const announcement = await readAnnouncement(
    announcementStore(c.env.APP_DB),
    c.req.param("id"),
    "public",
  );
  return announcement ? c.json(announcement) : c.notFound();
});
announcementAdminRoutes.get("/admin/announcements", async (c) => {
  const query = querySchema.safeParse(c.req.query());
  const page = query.success ? await list(c.env.APP_DB, query.data.cursor, "admin") : null;
  return page ? c.json(page) : c.json({ message: "検索条件が正しくありません。" }, 400);
});
announcementAdminRoutes.get("/admin/announcements/:id", async (c) => {
  const announcement = await readAnnouncement(
    announcementStore(c.env.APP_DB),
    c.req.param("id"),
    "admin",
  );
  return announcement ? c.json(announcement) : c.notFound();
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
  return c.json(await createAnnouncement(announcementStore(c.env.APP_DB), input.data), 201);
});
announcementAdminRoutes.patch("/admin/announcements/:id", async (c) => {
  const input = announcementPatchSchema.safeParse(await json(c.req.raw));
  if (!input.success) return c.json({ message: "入力内容を確認してください。" }, 400);
  const result = await updateAnnouncement(
    announcementStore(c.env.APP_DB),
    c.req.param("id"),
    input.data,
  );
  if (result.status === "not_found") return c.notFound();
  if (result.status === "conflict")
    return c.json({ message: "別の操作で更新されました。最新データを読み直してください。" }, 409);
  return c.json(result.announcement);
});
