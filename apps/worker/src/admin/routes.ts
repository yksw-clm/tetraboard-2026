import { readAcquisitionSnapshot } from "../analytics/acquisitionAggregation";
import type { Context } from "hono";
import { readAdminUsers, UserQueryError } from "./users";
import { Hono } from "hono";
import {
  analyticsFoundationSchema,
  registrationAnalyticsReportSchema,
  registrationAnalyticsQuerySchema,
  adminAnalyticsQuerySchema,
  adminAnalyticsSchema,
  adminUsersQuerySchema,
  adminUsersSchema,
  adminUserDetailSchema,
  acquisitionSnapshotSchema,
} from "@tetraboard/protocol";
import { type StoredProfile } from "../accounts/auth";
import { adminIdentity, type AdminEnv } from "./auth";
import { readRegistrationAnalytics } from "../analytics/registrationAggregation";
import { readAnalyticsFoundation } from "../analytics/foundation";
import { readAnalytics } from "./metrics";
export const adminRoutes = new Hono<{ Bindings: AdminEnv; Variables: { admin: StoredProfile } }>();
for (const path of [
  "/admin/session",
  "/admin/analytics",
  "/admin/analytics/foundation",
  "/admin/analytics/registration",
  "/admin/analytics/acquisition",
  "/admin/users",
  "/admin/users/:id",
]) {
  adminRoutes.use(path, async (c, next) => {
    c.header("Cache-Control", "no-store");
    const result = await adminIdentity(c.req.raw, c.env);
    if (result.status !== 200) return c.json({ message: result.message }, result.status);
    c.set("admin", result.user);
    await next();
  });
}
adminRoutes.onError((_error, c) => {
  c.header("Cache-Control", "no-store");
  return c.json({ message: "取得できません。時間をおいて再試行してください。" }, 503);
});
adminRoutes.get("/admin/session", (c) => {
  const user = c.get("admin");
  return c.json({ name: user.name, username: user.username });
});
adminRoutes.get("/admin/analytics", async (c) => {
  const query = adminAnalyticsQuerySchema.safeParse(c.req.query());
  if (!query.success) return c.json({ message: "期間の指定が正しくありません（最大3年）。" }, 400);
  return c.json(adminAnalyticsSchema.parse(await readAnalytics(c.env, query.data)));
});
adminRoutes.get("/admin/analytics/foundation", async (c) => {
  const query = adminAnalyticsQuerySchema.safeParse(c.req.query());
  if (!query.success) return c.json({ message: "期間の指定が正しくありません（最大3年）。" }, 400);
  return c.json(analyticsFoundationSchema.parse(await readAnalyticsFoundation(c.env, query.data)));
});
adminRoutes.get("/admin/analytics/registration", async (c) => {
  const query = registrationAnalyticsQuerySchema.safeParse(c.req.query());
  if (!query.success) return c.json({ message: "期間の指定が正しくありません（最大3年）。" }, 400);
  return c.json(
    registrationAnalyticsReportSchema.parse(await readRegistrationAnalytics(c.env, query.data)),
  );
});
async function users(
  c: Context<{ Bindings: AdminEnv; Variables: { admin: StoredProfile } }>,
  detail = false,
) {
  const query = adminUsersQuerySchema.safeParse(c.req.query());
  if (!query.success) return c.json({ message: "検索条件が正しくありません。" }, 400);
  try {
    const data = await readAdminUsers(
      c.env.APP_DB,
      query.data,
      detail ? c.req.param("id") : undefined,
    );
    if (detail)
      return data.users[0]
        ? c.json(adminUserDetailSchema.parse({ user: data.users[0] }))
        : c.json({ message: "ユーザーが見つかりません。" }, 404);
    return c.json(adminUsersSchema.parse(data));
  } catch (error) {
    if (error instanceof UserQueryError)
      return c.json({ message: "期間・並べ替え・続きの指定を確認してください（最大3年）。" }, 400);
    throw error;
  }
}
adminRoutes.get("/admin/users", (c) => users(c));
adminRoutes.get("/admin/users/:id", (c) => users(c, true));

adminRoutes.get("/admin/analytics/acquisition", async (c) => {
  const q = adminAnalyticsQuerySchema.safeParse(c.req.query());
  if (!q.success) return c.json({ message: "期間の指定が正しくありません。" }, 400);
  return c.json(acquisitionSnapshotSchema.parse(await readAcquisitionSnapshot(c.env, q.data)));
});
