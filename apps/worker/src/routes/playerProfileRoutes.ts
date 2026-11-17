import { Hono } from "hono";
import { getPlayerProfileContract } from "@tetraboard/protocol";
import { readPlayerProfile } from "@tetraboard/context-account";
import { playerProfilePorts } from "../adapters/account/playerProfile";
export const playerProfileRoutes = new Hono<{ Bindings: Env }>();
playerProfileRoutes.get(getPlayerProfileContract.path, async (c) => {
  c.header("Cache-Control", "no-store");
  const query = getPlayerProfileContract.query.safeParse(c.req.query());
  if (!query.success)
    return c.json({ message: "プレイヤー情報の取得条件が正しくありません。" }, 400);
  try {
    const result = await readPlayerProfile(playerProfilePorts(c.env), query.data);
    if ("status" in result) return c.json({ message: result.message }, result.status);
    return c.json(getPlayerProfileContract.response.parse(result));
  } catch {
    console.error("Player profile request failed");
    return c.json({ message: "プレイヤー情報を取得できませんでした。" }, 503);
  }
});
