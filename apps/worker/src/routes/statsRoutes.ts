import { Hono } from "hono";
import { getAccountStatsContract } from "@tetraboard/protocol";
import { accountIdentity } from "../adapters/account/auth";
import { readAccountStats } from "../adapters/record/stats";

export const statsRoutes = new Hono<{ Bindings: Env }>();
statsRoutes.get(getAccountStatsContract.path, async (c) => {
  c.header("Cache-Control", "no-store");
  try {
    const user = await accountIdentity(c.req.raw, c.env);
    if (!user) return c.json({ message: "ログインしてください。" }, 401);
    const query = getAccountStatsContract.query.safeParse({ game: c.req.query("game") });
    if (!query.success) return c.json({ message: "戦績の取得条件が正しくありません。" }, 400);
    return c.json(await readAccountStats(c.env.APP_DB, user.id, query.data.game));
  } catch {
    console.error("Account stats request failed");
    return c.json({ message: "戦績を取得できませんでした。もう一度お試しください。" }, 503);
  }
});
