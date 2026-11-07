import { z } from "zod";
import type { ExternalCpuWork } from "./fourReversiProgress";
import type { Position } from "@tetraboard/four-reversi";

export interface AiServiceBindings {
  AI_SERVICE_URL?: string;
  AI_SERVICE_TOKEN?: string;
  AI_SERVICE_TIMEOUT_MS?: string;
}

export const aiServiceEnabled = (bindings: AiServiceBindings) => !!bindings.AI_SERVICE_URL;
export function aiServiceTimeout(bindings: AiServiceBindings): number {
  const value = Number(bindings.AI_SERVICE_TIMEOUT_MS || 5000);
  return Number.isInteger(value) && value >= 100 && value <= 5000 ? value : 5000;
}

const responseSchema = z.strictObject({
  api_version: z.literal(1),
  game_id: z.literal("four-reversi"),
  ruleset_version: z.literal("four-reversi-singles-v1"),
  state_version: z.literal(1),
  request_id: z.string().max(64),
  position_revision: z.string().length(64),
  agent_id: z.enum(["four-reversi-random-v1", "four-reversi-greedy-v1", "four-reversi-maxn-v1"]),
  engine_version: z.string().min(1).max(32),
  position: z.strictObject({ x: z.int().min(0).max(7), y: z.int().min(0).max(7) }),
  diagnostics: z.strictObject({
    nodes: z.int().min(0).max(4096),
    completed_depth: z.int().min(0).max(4),
    interrupted: z.boolean(),
  }),
});

class ServiceError extends Error {
  constructor(
    readonly reason: string,
    readonly retryable = false,
  ) {
    super(reason);
  }
}

async function responseJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new ServiceError("invalid_response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8192) throw new ServiceError("response_too_large");
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error instanceof ServiceError ? error : new ServiceError("invalid_response");
  } finally {
    reader.releaseLock();
  }
}

export async function requestAiMove(
  bindings: AiServiceBindings,
  work: ExternalCpuWork,
): Promise<{ position: Position | null; reason?: string }> {
  const token = bindings.AI_SERVICE_TOKEN;
  let url: URL;
  try {
    url = new URL(bindings.AI_SERVICE_URL ?? "");
    if (
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
        )) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      !token ||
      token.length < 32 ||
      token.length > 256 ||
      !/^[\x21-\x7e]+$/.test(token)
    )
      throw Error();
  } catch {
    return { position: null, reason: "configuration" };
  }
  const { requestId, expiresAt, ...context } = work.job;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(context)),
  );
  const revision = Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
  const agentId = work.job.level === 1 ? "four-reversi-random-v1" : "four-reversi-greedy-v1";
  const body = JSON.stringify({
    api_version: 1,
    game_id: "four-reversi",
    ruleset_version: "four-reversi-singles-v1",
    state_version: 1,
    request_id: requestId,
    position_revision: revision,
    agent_id: agentId,
    seed: Number.parseInt(revision.slice(0, 8), 16),
    state: {
      board: work.game.board,
      turn: work.game.turn,
      moveNumber: work.game.moveNumber,
      lastMove: work.game.lastMove,
      consecutivePasses: work.game.consecutivePasses,
    },
  });
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    Math.max(1, Math.min(aiServiceTimeout(bindings), expiresAt - Date.now())),
  );
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetch(new URL("/v1/move", url), {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body,
          signal: controller.signal,
          redirect: "manual",
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new ServiceError(
            `http_${response.status}`,
            response.status === 429 || response.status >= 500,
          );
        }
        const parsed = responseSchema.safeParse(await responseJson(response));
        if (
          !parsed.success ||
          parsed.data.request_id !== requestId ||
          parsed.data.position_revision !== revision ||
          parsed.data.agent_id !== agentId
        )
          throw new ServiceError("invalid_response");
        return { position: parsed.data.position };
      } catch (error) {
        if (controller.signal.aborted) return { position: null, reason: "timeout" };
        if (attempt === 0 && (!(error instanceof ServiceError) || error.retryable)) continue;
        return { position: null, reason: error instanceof ServiceError ? error.reason : "network" };
      }
    }
    return { position: null, reason: "network" };
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}
