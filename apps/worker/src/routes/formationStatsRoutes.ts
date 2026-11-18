import { Hono } from "hono";
import { getFourShogiFormationStatsContract } from "@tetraboard/protocol";
import { accountIdentity } from "../accounts/auth";
import { readFormationStats } from "../adapters/record/formationStats";

export const formationStatsRoutes = new Hono<{ Bindings: Env }>();
formationStatsRoutes.get(getFourShogiFormationStatsContract.path, async (c) => {
  c.header("Cache-Control", "no-store");
  try {
    const user = await accountIdentity(c.req.raw, c.env);
    if (!user) return c.json({ message: "ログインしてください。" }, 401);
    return c.json(await readFormationStats(c.env.APP_DB, user.id));
  } catch {
    console.error("Formation stats request failed");
    return c.json({ message: "戦法別戦績を取得できませんでした。もう一度お試しください。" }, 503);
  }
});
