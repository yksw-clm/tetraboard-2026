import { privacyInput } from "./input";
import { Hono } from "hono";
import { legalVersion } from "@tetraboard/protocol/privacy";
import { accountIdentity } from "../accounts/auth";
export const legalRoutes = new Hono<{ Bindings: Env }>();
legalRoutes.use("/account/legal", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});
legalRoutes.onError((_err, c) =>
  c.json({ message: "同意を保存できませんでした。時間をおいて再試行してください。" }, 503),
);
legalRoutes.get("/account/legal", async (c) => {
  const user = await accountIdentity(c.req.raw, c.env);
  if (!user) return c.json({ message: "ログインしてください。" }, 401);
  const row = await c.env.APP_DB.prepare("SELECT version FROM legal_consents WHERE account_id = ?")
    .bind(user.id)
    .first<{ version: string }>();
  return c.json({ accepted: row?.version === legalVersion, version: legalVersion });
});
legalRoutes.post("/account/legal", async (c) => {
  if (c.req.header("Origin") !== c.env.APP_ORIGIN) return c.body(null, 403);
  const user = await accountIdentity(c.req.raw, c.env);
  if (!user) return c.body(null, 401);
  const input = await privacyInput(c.req.raw);
  if (input?.version !== legalVersion || input?.accepted !== true)
    return c.json({ message: "規約と年齢条件を確認してください。" }, 400);
  await c.env.APP_DB.prepare(
    "INSERT INTO legal_consents VALUES (?,?,?) ON CONFLICT(account_id) DO UPDATE SET version=excluded.version, accepted_at_ms=excluded.accepted_at_ms",
  )
    .bind(user.id, legalVersion, Date.now())
    .run();
  return c.json({ accepted: true, version: legalVersion });
});
