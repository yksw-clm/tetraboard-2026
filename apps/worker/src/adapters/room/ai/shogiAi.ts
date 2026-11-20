import { createShogiAiRequest } from "@tetraboard/shogi/definition";
import { z } from "zod";
import {
  aiServiceConfigured,
  configuredUrl,
  fetchAiGateway,
  responseJson,
  type AiServiceBindings,
} from "./aiService";

export const shogiAiEnabled = (bindings: AiServiceBindings) =>
  bindings.AI_SHOGI_ENABLED === "true" && aiServiceConfigured(bindings);

export type ShogiAiWork = {
  job: { requestId: string; roundId: string; positionRevision: number; expiresAt: number };
  moves: string[];
  nodes?: number;
  standardBook?: boolean;
};

const shogiStandardBook = "standard-v1";
const shogiResponseSchema = z.strictObject({
  request_id: z.string().uuid(),
  position_revision: z.string().length(64),
  engine_version: z.literal("yaneuraou-material-faeb37f0"),
  nodes: z.int().positive(),
  best_move: z.string().min(4).max(5),
  opening_book: z.literal(shogiStandardBook).optional(),
});

export async function requestShogiAiMove(bindings: AiServiceBindings, work: ShogiAiWork) {
  const url = configuredUrl(bindings);
  if (!url || bindings.AI_SHOGI_ENABLED !== "true") return null;
  const { requestId, roundId, positionRevision, expiresAt } = work.job;
  const request = createShogiAiRequest(work);
  const nodes = request.nodes;
  const openingBook = request.opening_book;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([roundId, positionRevision, work.moves])),
  );
  const revision = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const remaining = expiresAt - Date.now();
  if (remaining <= 0) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remaining);
  try {
    const response = await fetchAiGateway(bindings, new URL("/v1/shogi/move", url), {
      method: "POST",
      headers: {
        authorization: `Bearer ${bindings.AI_SERVICE_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        request_id: requestId,
        position_revision: revision,
        ...request,
      }),
      redirect: "manual",
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const parsed = shogiResponseSchema.safeParse(await responseJson(response));
    return parsed.success &&
      parsed.data.request_id === requestId &&
      parsed.data.position_revision === revision &&
      parsed.data.nodes === nodes &&
      parsed.data.opening_book === openingBook
      ? parsed.data.best_move
      : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
