import { acceptLegalConsent, readLegalConsent } from "@tetraboard/context-privacy";
import { legalVersion } from "@tetraboard/protocol/privacy";
import { Hono } from "hono";
import { accountIdentity } from "../accounts/auth";
import { D1LegalConsent } from "../adapters/privacy/consent";
import { privacyInput } from "./privacyInput";

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
  return c.json(await readLegalConsent(new D1LegalConsent(c.env.APP_DB), user.id, legalVersion));
});
legalRoutes.post("/account/legal", async (c) => {
  if (c.req.header("Origin") !== c.env.APP_ORIGIN) return c.body(null, 403);
  const user = await accountIdentity(c.req.raw, c.env);
  if (!user) return c.body(null, 401);
  const result = await acceptLegalConsent(
    new D1LegalConsent(c.env.APP_DB),
    user.id,
    await privacyInput(c.req.raw),
    legalVersion,
    Date.now,
  );
  if (!result) return c.json({ message: "規約と年齢条件を確認してください。" }, 400);
  return c.json(result);
});
