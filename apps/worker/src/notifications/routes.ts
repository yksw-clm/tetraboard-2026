import { Hono } from "hono";
import { z } from "zod";
import {
  notificationNumberSchema,
  notificationReadSchema,
  notificationReadAllSchema,
} from "@tetraboard/protocol";
import { accountIdentity } from "../accounts/auth";
import {
  hasUnreadNotifications,
  initializeNotifications,
  notificationUpperBound,
  readNotifications,
  visibleNotificationSql,
} from "./store";

export const notificationRoutes = new Hono<{ Bindings: Env; Variables: { accountId: string } }>();
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
    if (identity) await initializeNotifications(c.env.APP_DB, identity.id);
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
const querySchema = z
  .object({
    cursor: numberQuery.optional(),
    after: numberQuery.optional(),
    announcementId: z.string().min(1).max(80).optional(),
  })
  .strict();
notificationRoutes.get("/notifications", async (c) => {
  const query = querySchema.safeParse(c.req.query());
  if (!query.success) return c.json({ message: "取得条件を確認してください。" }, 400);
  const accountId = c.get("accountId");
  const upperBound = await notificationUpperBound(c.env.APP_DB, accountId);
  const rows = await readNotifications(c.env.APP_DB, accountId, {
    before: query.data.cursor,
    after: query.data.after,
    announcementId: query.data.announcementId,
  });
  const notifications = rows.slice(0, 20);
  return c.json({
    notifications,
    upperBound: Math.max(upperBound, notifications[0]?.id ?? 0),
    nextCursor: rows.length > 20 ? String(notifications.at(-1)!.id) : null,
  });
});
notificationRoutes.get("/notifications/:id", async (c) => {
  const id = numberQuery.safeParse(c.req.param("id"));
  if (!id.success) return c.notFound();
  const row = (await readNotifications(c.env.APP_DB, c.get("accountId"), { id: id.data }))[0];
  return row ? c.json(row) : c.notFound();
});
notificationRoutes.get("/account/notifications/unread", async (c) => {
  const db = c.env.APP_DB,
    id = c.get("accountId");
  return c.json({
    hasUnread: await hasUnreadNotifications(db, id),
    upperBound: await notificationUpperBound(db, id),
  });
});
notificationRoutes.post("/account/notifications/read", async (c) => {
  const input = notificationReadSchema.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ message: "通知の指定を確認してください。" }, 400);
  const id = c.get("accountId"),
    db = c.env.APP_DB;
  const result = await db
    .prepare(`INSERT OR IGNORE INTO account_notification_reads(account_id,notification_seq)
    SELECT ?,e.seq FROM notification_events e WHERE e.seq=? AND ${visibleNotificationSql} RETURNING notification_seq`)
    .bind(id, input.data.id, id)
    .first();
  if (!result && !(await readNotifications(db, id, { id: input.data.id })).length)
    return c.notFound();
  return c.json({ ok: true });
});
notificationRoutes.post("/account/notifications/read-all", async (c) => {
  const input = notificationReadAllSchema.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ message: "通知の指定を確認してください。" }, 400);
  const db = c.env.APP_DB,
    id = c.get("accountId");
  // 入力を実在する通知上限で制限し、将来の通知まで既読にする指定を拒否します。
  const frontier = await db
    .prepare("SELECT seq FROM sqlite_sequence WHERE name='notification_events'")
    .first<{ seq: number }>();
  if (input.data.through > (frontier?.seq ?? 0))
    return c.json({ message: "通知の上限を確認してください。" }, 400);
  await db
    .prepare(
      "UPDATE account_notification_state SET read_all_seq=MAX(read_all_seq,?) WHERE account_id=?",
    )
    .bind(input.data.through, id)
    .run();
  return c.json({ ok: true });
});
