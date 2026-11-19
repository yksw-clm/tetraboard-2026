import { z } from "zod";
import {
  configuredUrl,
  fetchAiGateway,
  responseJson,
  ServiceError,
  type AiServiceBindings,
} from "./aiService";

export type RatedAiGame = "four-shogi" | "four-reversi" | "shogi" | "reversi";

export async function requestRatedAiWarmup(
  bindings: AiServiceBindings,
  game: RatedAiGame,
  deadlineMs: number,
): Promise<string | null> {
  const url = configuredUrl(bindings);
  if (!url) return "configuration";
  const remaining = deadlineMs - Date.now();
  if (remaining <= 0) return "timeout";
  const endpoint = new URL("/admin/warmup", url);
  endpoint.searchParams.set("game", game);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remaining);
  try {
    const response = await fetchAiGateway(bindings, endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${bindings.AI_SERVICE_TOKEN}` },
      redirect: "manual",
      signal: controller.signal,
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      return `http_${response.status}`;
    }
    const body = await responseJson(response);
    if (controller.signal.aborted || Date.now() >= deadlineMs) return "timeout";
    return z.object({ status: z.literal("ok") }).safeParse(body).success
      ? null
      : "invalid_response";
  } catch (error) {
    if (controller.signal.aborted || Date.now() >= deadlineMs) return "timeout";
    return error instanceof ServiceError ? error.reason : "network";
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
