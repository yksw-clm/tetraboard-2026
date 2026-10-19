import { Hono } from "hono";
import {
  adminAnalyticsQuerySchema,
  adminAnalyticsSchema,
  adminUsersQuerySchema,
  adminUsersSchema,
} from "@tetraboard/protocol";
import { profileAvatarUrl, type StoredProfile } from "../accounts/auth";
import { accountCreatedAtMsSql } from "../accounts/timestamps";
import { adminIdentity, type AdminEnv } from "./auth";
import { readAnalytics } from "./metrics";
export const adminRoutes = new Hono<{ Bindings: AdminEnv; Variables: { admin: StoredProfile } }>();
for (const path of ["/admin/session", "/admin/analytics", "/admin/users"]) {
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
  const rows = await c.env.APP_DB.prepare(`WITH registered_users AS (
      SELECT id, name, username, avatarKey, ${accountCreatedAtMsSql("createdAt")} AS createdAtMs, profileCompleted,isAnonymous
      FROM user WHERE NOT EXISTS(SELECT 1 FROM guest_account_merges WHERE guest_id=user.id) AND NOT EXISTS (SELECT 1 FROM deleted_accounts d WHERE d.id=user.id))
    SELECT * FROM registered_users WHERE (name LIKE ? ESCAPE '\\' OR username LIKE ? ESCAPE '\\')
    ${cursor ? "AND (createdAtMs < ? OR (createdAtMs = ? AND id < ?))" : ""}
    ORDER BY createdAtMs DESC, id DESC LIMIT 51`)
    .bind(search, search, ...(cursor ? [cursor.at, cursor.at, cursor.id] : []))
    .all<{
      id: string;
      name: string;
      username: string | null;
      avatarKey: string | null;
      createdAtMs: number;
      profileCompleted: number;
      isAnonymous: number | null;
    }>();
  const page = rows.results.slice(0, 50);
  const last = page.at(-1);
  return c.json(
    adminUsersSchema.parse({
      users: page.map((user) => ({
        name: user.name,
        username: user.username,
        avatarUrl: profileAvatarUrl(user.avatarKey),
        createdAtMs: user.createdAtMs,
        profileCompleted: Boolean(user.profileCompleted),
        ...(user.isAnonymous ? { isGuest: true } : {}),
      })),
      nextCursor:
        rows.results.length > 50 && last
          ? btoa(JSON.stringify({ at: last.createdAtMs, id: last.id }))
          : null,
    }),
  );
});
