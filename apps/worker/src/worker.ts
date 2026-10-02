import { healthzContract } from "@tetraboard/protocol";
import { accountRoutes, deleteUnusedAvatars } from "./accounts/accountRoutes";
import { recoverAccountReservations } from "./accounts/roomAccounts";
import { matchRoutes } from "./accounts/matchRoutes";
import { statsRoutes } from "./accounts/statsRoutes";
import { Hono } from "hono";
import { roomRoutes } from "./rooms/roomRoutes";
import { deleteExpiredReports } from "./rooms/reportStore";

export { GameRoom } from "./rooms/gameRoom";

const api = new Hono<{ Bindings: Env }>();

api.on(healthzContract.method, healthzContract.path, (context) => {
  context.header("Cache-Control", "no-store");
  const response = healthzContract.response.parse({ status: "ok" });
  return context.json(response);
});

api.route("/", matchRoutes);
api.route("/", statsRoutes);
api.route("/", accountRoutes);
api.route("/", roomRoutes);

// 本番の同一オリジン配信と、既存のWorker直接アクセスを両方扱います。
const app = new Hono<{ Bindings: Env }>().route("/api", api).route("/", api);

app.notFound((context) => context.text("Not Found", 404));

export default Object.assign(app, {
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await deleteExpiredReports(env.APP_DB);
    await recoverAccountReservations(env);
    await deleteUnusedAvatars(env);
    await env.APP_DB.batch([
      env.APP_DB.prepare("DELETE FROM session WHERE expiresAt < ?").bind(Date.now()),
      env.APP_DB.prepare("DELETE FROM verification WHERE expiresAt < ?").bind(Date.now()),
      env.APP_DB.prepare("DELETE FROM rateLimit WHERE lastRequest < ?").bind(Date.now() - 86400000),
    ]);
  },
});
