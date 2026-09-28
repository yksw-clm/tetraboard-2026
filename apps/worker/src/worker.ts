import { Hono } from "hono";

const app = new Hono<{ Bindings: Env }>();

app.get("/healthz", (context) => {
  context.header("Cache-Control", "no-store");
  return context.json({ status: "ok" });
});

app.notFound((context) => context.text("Not Found", 404));

export default app;
