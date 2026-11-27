import { Hono } from "hono";
import { z } from "zod";
import {
  notificationNumberSchema,
  notificationReadSchema,
  notificationReadAllSchema,
} from "@tetraboard/protocol";
import { accountIdentity } from "../adapters/account/auth";
import { notificationRequestStore } from "../adapters/community/notifications";
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  prepareNotifications,
  readNotification,
  readNotificationStatus,
  type NotificationStore,
} from "@tetraboard/context-community";

export const notificationRoutes = new Hono<{
  Bindings: Env;
  Variables: { accountId: string; notifications: NotificationStore };
}>();
for (const path of ["/notifications", "/notifications/*", "/account/notifications/*"]) {
  notificationRoutes.use(path, async (c, next) => {
    c.header("Cache-Control", "no-store");
    const identity = await accountIdentity(c.req.raw, c.env);
    c.set("accountId", identity?.id ?? "");
    if (c.req.path.includes("/account/notifications/")) {
      if (!identity) return c.json({ message: "ログインしてください。" }, 401);
      if (c.req.method !== "GET" && c.req.header("Origin") !== c.env.APP_ORIGIN)
        return c.json({ message: "操作元を確認できません。" }, 403);
    }
    const store = notificationRequestStore(c.env.APP_DB);
    if (identity) await prepareNotifications(store, identity.id);
    c.set("notifications", store);
    await next();
  });
}
notificationRoutes.onError(
  () =>
    new Response(JSON.stringify({ message: "お知らせを取得できませんでした。" }), {
      status: 503,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    }),
);
const numberQuery = z.string().regex(/^\d+$/).transform(Number).pipe(notificationNumberSchema);
const repliesQuery = z.literal("1").optional();
const invalidQuery = { message: "取得条件を確認してください。" };
const querySchema = z.object({
  cursor: numberQuery.optional(),
  after: numberQuery.optional(),
  announcementId: z.string().min(1).max(80).optional(),
  replies: repliesQuery,
});
notificationRoutes.get("/notifications", async (c) => {
  const query = querySchema.safeParse(c.req.query());
  if (!query.success) return c.json(invalidQuery, 400);
  return c.json(
    await listNotifications(c.get("notifications"), c.get("accountId"), {
      before: query.data.cursor,
      after: query.data.after,
      announcementId: query.data.announcementId,
      includeReplies: query.data.replies === "1",
    }),
  );
});
notificationRoutes.get("/notifications/:id", async (c) => {
  const id = numberQuery.safeParse(c.req.param("id"));
  if (!id.success) return c.notFound();
  const replies = repliesQuery.safeParse(c.req.query("replies"));
  if (!replies.success) return c.json(invalidQuery, 400);
  const row = await readNotification(
    c.get("notifications"),
    c.get("accountId"),
    id.data,
    replies.data === "1",
  );
  return row ? c.json(row) : c.notFound();
});
notificationRoutes.get("/account/notifications/unread", async (c) => {
  const replies = repliesQuery.safeParse(c.req.query("replies"));
  if (!replies.success) return c.json(invalidQuery, 400);
  return c.json(
    await readNotificationStatus(c.get("notifications"), c.get("accountId"), replies.data === "1"),
  );
});
notificationRoutes.post("/account/notifications/read", async (c) => {
  const input = notificationReadSchema.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ message: "通知の指定を確認してください。" }, 400);
  if (!(await markNotificationRead(c.get("notifications"), c.get("accountId"), input.data.id)))
    return c.notFound();
  return c.json({ ok: true });
});
notificationRoutes.post("/account/notifications/read-all", async (c) => {
  const input = notificationReadAllSchema.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ message: "通知の指定を確認してください。" }, 400);
  if (
    !(await markAllNotificationsRead(
      c.get("notifications"),
      c.get("accountId"),
      input.data.through,
    ))
  )
    return c.json({ message: "通知の上限を確認してください。" }, 400);
  return c.json({ ok: true });
});
