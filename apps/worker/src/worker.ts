import { healthzContract } from "@tetraboard/protocol";
import { Hono } from "hono";

const app = new Hono<{ Bindings: Env }>();

app.on(healthzContract.method, healthzContract.path, (context) => {
  context.header("Cache-Control", "no-store");
  const response = healthzContract.response.parse({ status: "ok" });
  return context.json(response);
});

app.notFound((context) => context.text("Not Found", 404));

export default app;
