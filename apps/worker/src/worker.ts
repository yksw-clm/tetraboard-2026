import { healthzContract } from "@tetraboard/protocol";
import { Hono } from "hono";
import { roomRoutes } from "./rooms/roomRoutes";

export { GameRoom } from "./rooms/gameRoom";

const app = new Hono<{ Bindings: Env }>();

app.on(healthzContract.method, healthzContract.path, (context) => {
  context.header("Cache-Control", "no-store");
  const response = healthzContract.response.parse({ status: "ok" });
  return context.json(response);
});

app.route("/", roomRoutes);

app.notFound((context) => context.text("Not Found", 404));

export default app;
