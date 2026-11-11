import { Container } from "@cloudflare/containers";
import { authorized, validToken } from "./access";

interface Bindings {
  AI_CONTAINER: DurableObjectNamespace<AiContainer>;
  FOUR_SHOGI_CONTAINER?: DurableObjectNamespace<FourShogiContainer>;
  AI_WARMUP_ENABLED?: string;
  SHOGI_CONTAINER?: DurableObjectNamespace<ShogiContainer>;
  REVERSI_CONTAINER?: DurableObjectNamespace<ReversiContainer>;
  AI_SERVICE_TOKEN?: string;
  AI_SHOGI_ENABLED?: string;
  FOUR_SHOGI_DIAGNOSTICS?: string;
}

// 既存の四人リバーシ用Container applicationとDurable Objectを引き継ぎます。
export class AiContainer extends Container<Bindings> {
  defaultPort = 3001;
  sleepAfter = this.env.FOUR_SHOGI_CONTAINER ? "11m" : "10s";
  enableInternet = false;
  envVars = {
    AI_SERVICE_TOKEN: this.env.AI_SERVICE_TOKEN ?? "",
    AI_SERVICE_CONCURRENCY: "4",
  };
}

export class FourShogiContainer extends Container<Bindings> {
  defaultPort = 3001;
  sleepAfter = "11m";
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

export class ReversiContainer extends Container<Bindings> {
  defaultPort = 3001;
  // 通常リバーシで選べる最大の持ち時間と、次のCPU手番までの待ち時間をカバーします。
  sleepAfter = "11m";
  enableInternet = false;
  envVars = {
    AI_SERVICE_TOKEN: this.env.AI_SERVICE_TOKEN ?? "",
    AI_REVERSI_ENGINE: "/opt/egaroucid/egaroucid",
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
    const warmup =
      path === "/admin/warmup" && request.method === "POST" && env.AI_WARMUP_ENABLED === "true";
    const game = url.searchParams.get("game");
    const shogi = path === "/v1/shogi/move" || ((status || warmup) && game === "shogi");
    const reversi = path === "/v1/reversi/move" || ((status || warmup) && game === "reversi");
    const fourShogi =
      path === "/v1/four-shogi/move" || ((status || warmup) && game === "four-shogi");
    const fourReversi =
      path === "/v1/move" ||
      path === "/v2/move" ||
      (status && game === null) ||
      ((status || warmup) && game === "four-reversi");
    if (
      (!status && request.method !== "POST") ||
      (!fourReversi && !fourShogi && !shogi && !reversi) ||
      (shogi && env.AI_SHOGI_ENABLED !== "true")
    )
      return reply({ error: "not_found" }, 404);

    const container = reversi
      ? env.REVERSI_CONTAINER?.getByName("reversi-v1")
      : shogi
        ? env.SHOGI_CONTAINER?.getByName("shogi-v1")
        : fourShogi && (env.FOUR_SHOGI_CONTAINER || env.AI_WARMUP_ENABLED === "true")
          ? env.FOUR_SHOGI_CONTAINER?.getByName("four-shogi-v1")
          : env.AI_CONTAINER.getByName("shared-v1");
    if (!container) return reply({ error: "not_found" }, 404);
    const requestId = request.headers.get("x-tetraboard-ai-request-id");
    const attempt = request.headers.get("x-tetraboard-ai-attempt");
    const trace =
      env.FOUR_SHOGI_DIAGNOSTICS === "true" &&
      path === "/v1/four-shogi/move" &&
      requestId !== null &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId) &&
      (attempt === "1" || attempt === "2");
    const started = performance.now();
    const logFailure = (reason: string, httpStatus: number) => {
      if (trace)
        console.info({
          event: "four_shogi_ai_gateway_failed",
          game: "four-shogi",
          requestId,
          attempt: Number(attempt),
          elapsedMs: Math.round(performance.now() - started),
          reason,
          httpStatus,
        });
    };
    try {
      if (status) return reply(await container.getState());
      if (warmup) {
        // 外部プロセスを使う二人ゲームは、着手生成まで終えてから準備完了にします。
        const endpoint = new URL(shogi || reversi ? "/admin/warmup" : "/health", url);
        if (shogi || reversi) endpoint.searchParams.set("game", game!);
        const health = await container.fetch(
          new Request(endpoint, {
            method: shogi || reversi ? "POST" : "GET",
            headers: shogi || reversi ? request.headers : undefined,
            signal: request.signal,
          }),
        );
        const body = health.ok ? await health.json<{ status?: string }>() : null;
        if (!health.ok) void health.body?.cancel().catch(() => {});
        return body?.status === "ok"
          ? reply({ status: "ok" })
          : reply({ error: "unavailable" }, 503);
      }
      const response = await container.fetch(request);
      if (!response.ok) logFailure("container_http_error", response.status);
      return response;
    } catch {
      logFailure("container_fetch_exception", 503);
      return reply({ error: "unavailable" }, 503);
    }
  },
} satisfies ExportedHandler<Bindings>;
