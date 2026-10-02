import { healthzContract } from "@tetraboard/protocol";
import { Hono } from "hono";
import { roomRoutes } from "./rooms/roomRoutes";
import { deleteExpiredReports } from "./rooms/reportStore";

import { accountRoutes } from "./accounts/accountRoutes";

export { GameRoom } from "./rooms/gameRoom";

const api = new Hono<{ Bindings: Env }>();

api.on(healthzContract.method, healthzContract.path, (context) => {
  context.header("Cache-Control", "no-store");
  const response = healthzContract.response.parse({ status: "ok" });
  return context.json(response);
});

api.route("/", accountRoutes);
api.route("/", roomRoutes);

// 本番の同一オリジン配信と、既存のWorker直接アクセスを両方扱います。
const app = new Hono<{ Bindings: Env }>().route("/api", api).route("/", api);

app.notFound((context) => context.text("Not Found", 404));

export default Object.assign(app, {
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await deleteExpiredReports(env.APP_DB);
  },
});
