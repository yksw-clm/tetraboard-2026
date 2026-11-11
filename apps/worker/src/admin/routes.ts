import { Hono } from "hono";
import {
  analyticsFoundationSchema,
  registrationAnalyticsReportSchema,
  registrationAnalyticsQuerySchema,
  adminAnalyticsQuerySchema,
  adminAnalyticsSchema,
  adminUsersQuerySchema,
  adminUsersSchema,
} from "@tetraboard/protocol";
import { accountAvatarUrl, type StoredProfile } from "../accounts/auth";
import { accountCreatedAtMsSql } from "../accounts/timestamps";
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
  "/admin/users",
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
adminRoutes.get("/admin/users", async (c) => {
  const query = adminUsersQuerySchema.safeParse(c.req.query());
  if (!query.success) return c.json({ message: "検索条件が正しくありません。" }, 400);
  let cursor: { at: number; id: string } | null = null;
  if (query.data.cursor) {
    try {
      const value = JSON.parse(atob(query.data.cursor));
      if (
        !Number.isSafeInteger(value.at) ||
        value.at < 0 ||
        typeof value.id !== "string" ||
        !value.id ||
        value.id.length > 200
      )
        throw new Error();
      cursor = value;
    } catch {
      return c.json({ message: "続きの指定が正しくありません。" }, 400);
    }
  }
  const search = `%${query.data.search.replace(/^@/, "").replace(/[\\%_]/g, "\\$&")}%`;
  const rows = await c.env.APP_DB.prepare(
    `WITH listed_users AS (
      SELECT id, name, username, avatarKey, avatarPresetId, ${accountCreatedAtMsSql("createdAt")} AS createdAtMs, profileCompleted,isAnonymous
      FROM user WHERE COALESCE(isAnonymous, 0) = ? AND NOT EXISTS(SELECT 1 FROM guest_account_merges WHERE guest_id=user.id) AND NOT EXISTS (SELECT 1 FROM deleted_accounts d WHERE d.id=user.id))
    SELECT listed_users.*, usage.last_login_at_ms, usage.last_used_day FROM listed_users
    LEFT JOIN account_usage usage ON usage.account_id=listed_users.id WHERE (name LIKE ? ESCAPE '\\' OR username LIKE ? ESCAPE '\\')
    ${cursor ? "AND (createdAtMs < ? OR (createdAtMs = ? AND id < ?))" : ""}
    ORDER BY createdAtMs DESC, id DESC LIMIT 51`,
  )
    .bind(
      query.data.kind === "guest" ? 1 : 0,
      search,
      search,
      ...(cursor ? [cursor.at, cursor.at, cursor.id] : []),
    )
    .all<{
      id: string;
      name: string;
      username: string | null;
      avatarKey: string | null;
      avatarPresetId: string | null;
      createdAtMs: number;
      profileCompleted: number;
      isAnonymous: number | null;
      last_login_at_ms: number | null;
      last_used_day: string | null;
    }>();
  const page = rows.results.slice(0, 50);
  const last = page.at(-1);
  return c.json(
    adminUsersSchema.parse({
      users: page.map((user) => ({
        name: user.name,
        username: user.username,
        avatarUrl: accountAvatarUrl(user),
        createdAtMs: user.createdAtMs,
        profileCompleted: Boolean(user.profileCompleted),
        lastLoginAtMs: user.last_login_at_ms,
        lastUsedDay: user.last_used_day,
        ...(user.isAnonymous ? { isGuest: true } : {}),
      })),
      nextCursor:
        rows.results.length > 50 && last
          ? btoa(JSON.stringify({ at: last.createdAtMs, id: last.id }))
          : null,
    }),
  );
});
