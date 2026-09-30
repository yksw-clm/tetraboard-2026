import { healthzContract } from "@tetraboard/protocol";
import { Hono } from "hono";
import { roomRoutes } from "./rooms/roomRoutes";
import { deleteExpiredReports } from "./rooms/reportStore";

export { GameRoom } from "./rooms/gameRoom";

const app = new Hono<{ Bindings: Env }>();

app.on(healthzContract.method, healthzContract.path, (context) => {
  context.header("Cache-Control", "no-store");
  const response = healthzContract.response.parse({ status: "ok" });
  return context.json(response);
});

app.route("/", roomRoutes);

app.notFound((context) => context.text("Not Found", 404));

export default Object.assign(app, {
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await deleteExpiredReports(env.LOBBY_DB);
  },
});
