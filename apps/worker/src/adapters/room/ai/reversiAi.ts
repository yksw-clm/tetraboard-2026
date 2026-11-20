import { z } from "zod";
import {
  aiServiceConfigured,
  configuredUrl,
  fetchAiGateway,
  responseJson,
  type AiServiceBindings,
} from "./aiService";

export const reversiAiEnabled = (bindings: AiServiceBindings) =>
  bindings.AI_REVERSI_ENABLED === "true" && aiServiceConfigured(bindings);

export type ReversiAiWork = {
  job: { requestId: string; roundId: string; moveNumber: number; expiresAt: number };
  board: string;
  blackToMove: boolean;
  level: number;
};

const reversiResponseSchema = z.strictObject({
  request_id: z.string().uuid(),
  position_revision: z.string().length(64),
  engine_version: z.literal("egaroucid-console-7.8.2-0c1b84ef"),
  level: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8)]),
  position: z.strictObject({ x: z.int().min(0).max(7), y: z.int().min(0).max(7) }),
});

export async function requestReversiAiMove(bindings: AiServiceBindings, work: ReversiAiWork) {
  const url = configuredUrl(bindings);
  if (!url || bindings.AI_REVERSI_ENABLED !== "true") return null;
  const { requestId, roundId, moveNumber, expiresAt } = work.job;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify([roundId, moveNumber, work.board, work.blackToMove, work.level]),
    ),
  );
  const revision = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const remaining = expiresAt - Date.now();
  if (remaining <= 0) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remaining);
  try {
    const response = await fetchAiGateway(bindings, new URL("/v1/reversi/move", url), {
      method: "POST",
      headers: {
        authorization: `Bearer ${bindings.AI_SERVICE_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        request_id: requestId,
        position_revision: revision,
        level: work.level,
        board: work.board,
        black_to_move: work.blackToMove,
      }),
      redirect: "manual",
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const parsed = reversiResponseSchema.safeParse(await responseJson(response));
    return parsed.success &&
      parsed.data.request_id === requestId &&
      parsed.data.position_revision === revision &&
      parsed.data.level === work.level
      ? parsed.data.position
      : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
