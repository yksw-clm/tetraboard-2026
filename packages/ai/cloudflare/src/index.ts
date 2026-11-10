import { Container } from "@cloudflare/containers";
import { authorized, validToken } from "./access";

interface Bindings {
  AI_CONTAINER: DurableObjectNamespace<AiContainer>;
  SHOGI_CONTAINER?: DurableObjectNamespace<ShogiContainer>;
  AI_SERVICE_TOKEN?: string;
  AI_SHOGI_ENABLED?: string;
}

// 既存の四人リバーシ用Container applicationとDurable Objectを引き継ぎます。
export class AiContainer extends Container<Bindings> {
  defaultPort = 3001;
  sleepAfter = "10s";
  enableInternet = false;
  envVars = {
    AI_SERVICE_TOKEN: this.env.AI_SERVICE_TOKEN ?? "",
    AI_SERVICE_CONCURRENCY: "4",
  };
}

export class ShogiContainer extends Container<Bindings> {
  defaultPort = 3001;
  // 通常将棋の最大10分＋30秒の手番と、次のAI要求までの待ち時間をカバーします。
  sleepAfter = "11m";
  enableInternet = false;
  envVars = {
    AI_SERVICE_TOKEN: this.env.AI_SERVICE_TOKEN ?? "",
    AI_SHOGI_ENGINE: "/usr/local/bin/yaneuraou",
  };
}

function reply(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export default {
  async fetch(request: Request, env: Bindings): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    // 公開healthはContainerを起動せず、入口だけの稼働を示します。
    if (path === "/health" && request.method === "GET")
      return reply({ status: "ok", api_version: 1, component: "gateway" });
    if (!validToken(env.AI_SERVICE_TOKEN)) return reply({ error: "unavailable" }, 503);
    if (!(await authorized(request, env.AI_SERVICE_TOKEN)))
      return reply({ error: "unauthorized" }, 401);
    const status = path === "/admin/status" && request.method === "GET";
    const statusGame = url.searchParams.get("game");
    const shogi = path === "/v1/shogi/move" || (status && statusGame === "shogi");
    const fourReversi =
      (request.method === "POST" && (path === "/v1/move" || path === "/v2/move")) ||
      (status && (statusGame === null || statusGame === "four-reversi"));
    if (
      (!status && request.method !== "POST") ||
      (!fourReversi && !shogi) ||
      (shogi && env.AI_SHOGI_ENABLED !== "true")
    )
      return reply({ error: "not_found" }, 404);

    const container = shogi
      ? env.SHOGI_CONTAINER?.getByName("shogi-v1")
      : env.AI_CONTAINER.getByName("shared-v1");
    if (!container) return reply({ error: "not_found" }, 404);
    try {
      return status ? reply(await container.getState()) : await container.fetch(request);
    } catch {
      return reply({ error: "unavailable" }, 503);
    }
  },
} satisfies ExportedHandler<Bindings>;
