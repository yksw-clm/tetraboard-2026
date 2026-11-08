import { Container } from "@cloudflare/containers";
import { authorized, validToken } from "./access";

interface Bindings {
  AI_CONTAINER: DurableObjectNamespace<AiContainer>;
  AI_SERVICE_TOKEN?: string;
}

export class AiContainer extends Container<Bindings> {
  defaultPort = 3001;
  sleepAfter = "10s";
  enableInternet = false;
  envVars = {
    AI_SERVICE_TOKEN: this.env.AI_SERVICE_TOKEN ?? "",
    AI_SERVICE_CONCURRENCY: "2",
  };
}

function reply(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export default {
  async fetch(request: Request, env: Bindings): Promise<Response> {
    const path = new URL(request.url).pathname;
    // 公開healthはContainerを起動せず、入口だけの稼働を示します。
    if (path === "/health" && request.method === "GET")
      return reply({ status: "ok", api_version: 1, component: "gateway" });
    if (!validToken(env.AI_SERVICE_TOKEN)) return reply({ error: "unavailable" }, 503);
    if (!(await authorized(request, env.AI_SERVICE_TOKEN)))
      return reply({ error: "unauthorized" }, 401);
    const container = env.AI_CONTAINER.getByName("shared-v1");
    if (path === "/admin/status" && request.method === "GET")
      return reply(await container.getState());
    if (!["/v1/move", "/v2/move"].includes(path) || request.method !== "POST")
      return reply({ error: "not_found" }, 404);
    try {
      return await container.fetch(request);
    } catch {
      return reply({ error: "unavailable" }, 503);
    }
  },
} satisfies ExportedHandler<Bindings>;
