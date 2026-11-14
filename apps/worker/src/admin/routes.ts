import { Hono } from "hono";
import { type StoredProfile } from "../accounts/auth";
import { adminIdentity, type AdminEnv } from "./auth";
import { kpiQuerySchema, kpiReportSchema } from "@tetraboard/protocol";
import { readKpi } from "../kpi/report";
export const adminRoutes = new Hono<{ Bindings: AdminEnv; Variables: { admin: StoredProfile } }>();
for (const path of ["/admin/session", "/admin/kpi"]) {
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
adminRoutes.get("/admin/kpi", async (c) => {
  const query = kpiQuerySchema.safeParse(c.req.query());
  if (!query.success) return c.json({ message: "期間の指定が正しくありません（最大92日）。" }, 400);
  return c.json(kpiReportSchema.parse(await readKpi(c.env, query.data)));
});
