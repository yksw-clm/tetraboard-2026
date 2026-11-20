import { claimBadgeNotification, updateBadgeNotification } from "@tetraboard/context-record";
import { badgeNotificationStore } from "../adapters/record/badgeNotifications";
import { Hono } from "hono";
import {
  badgeNotificationClaimSchema,
  badgeNotificationOperationSchema,
  badgeNotificationResponseSchema,
  getBadgeIds,
} from "@tetraboard/protocol";
import { accountIdentity, type StoredProfile } from "../adapters/account/auth";

export const badgeNotificationRoutes = new Hono<{
  Bindings: Env;
  Variables: { user: StoredProfile };
}>();
badgeNotificationRoutes.use("/account/badge-notifications/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  if (c.req.header("Origin") !== c.env.APP_ORIGIN)
    return c.json({ message: "操作元を確認できません。" }, 403);
  const user = await accountIdentity(c.req.raw, c.env);
  if (!user) return c.json({ message: "ログインしてください。" }, 401);
  c.set("user", user);
  await next();
});
badgeNotificationRoutes.onError((_error, c) => {
  console.error("Badge notification request failed");
  return c.json({ message: "通知を取得できませんでした。" }, 503);
});
badgeNotificationRoutes.post("/account/badge-notifications/claim", async (c) => {
  const input = badgeNotificationClaimSchema.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ message: "通知の取得条件が正しくありません。" }, 400);
  const notification = await claimBadgeNotification(
    badgeNotificationStore(c.env.APP_DB),
    { accountId: c.get("user").id, token: input.data.token },
    Date.now(),
    getBadgeIds,
  );
  if (!notification) return c.json({ notification: null });
  return c.json(badgeNotificationResponseSchema.parse({ notification }));
});
for (const operation of ["shown", "renew", "release"] as const) {
  badgeNotificationRoutes.post(`/account/badge-notifications/${operation}`, async (c) => {
    const input = badgeNotificationOperationSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ message: "通知の指定が正しくありません。" }, 400);
    const updated = await updateBadgeNotification(
      badgeNotificationStore(c.env.APP_DB),
      operation,
      { accountId: c.get("user").id, ...input.data },
      Date.now(),
    );
    if (!updated) return c.json({ message: "通知の取得権が切れました。" }, 409);
    return c.json({ ok: true });
  });
}
