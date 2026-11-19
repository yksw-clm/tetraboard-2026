import { fourShogiDefinition } from "@tetraboard/four-shogi/definition";
import { fourShogiActionSchema } from "@tetraboard/protocol";
import { z } from "zod";
import { logFourShogiDiagnostic } from "../../../fourShogiDiagnostics";
import type { FourShogiAiWork } from "../../../rooms/fourShogiProgress";
import {
  configuredUrl,
  fetchAiGateway,
  responseJson,
  ServiceError,
  type AiServiceBindings,
} from "./aiService";

const fourShogiMoveResponse = z.object({
  api_version: z.literal(1),
  rules_version: z.literal(1),
  request_id: z.uuid(),
  position_revision: z.string().length(64),
  engine_version: z.string(),
  profile_id: z.string(),
  max_work: z.int().positive(),
  max_time_ms: z.literal(500),
  action: fourShogiActionSchema,
  diagnostics: z.object({ work: z.int().nonnegative() }),
});

export type FourShogiAiFailure =
  | "configuration"
  | "timeout"
  | "network"
  | "invalid_response"
  | `http_${number}`;

export type FourShogiAiResult =
  | { action: z.infer<typeof fourShogiActionSchema>; reason?: never; retried?: true }
  | { action: null; reason: FourShogiAiFailure };

type FourShogiMoveRequest = {
  url: URL;
  requestId: string;
  revision: string;
  body: string;
};

function createFourShogiAiRequest(
  work: FourShogiAiWork,
  side: FourShogiAiWork["job"]["side"],
  requestId: string,
  revision: string,
) {
  const { api_version, rules_version, ...request } =
    fourShogiDefinition.cpu.external!.createRequest(
      fourShogiDefinition.rules.createInitialState(fourShogiDefinition.catalog.defaultSettings),
      side,
      2,
      { events: work.events, profile: work.profile },
    );
  return JSON.stringify({
    api_version,
    rules_version,
    request_id: requestId,
    position_revision: revision,
    ...request,
  });
}

function startFourShogiAiAttempt(
  bindings: AiServiceBindings,
  matchId: string,
  requestId: string,
  attempt: number,
  atMs: number,
  remaining: number,
) {
  // 最初の通信が無応答でも、総期限内で同じ要求を再試行できる時間を残します。
  const budgetMs =
    attempt === 1 ? Math.min(2000, Math.max(1, Math.floor(remaining * 0.4))) : remaining;
  const attemptDeadlineMs = atMs + budgetMs;
  const started = performance.now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new ServiceError("attempt_timeout"));
      controller.abort();
    }, budgetMs);
  });
  const diagnostic = {
    matchId,
    requestId,
    attempt,
    atMs,
    budgetMs,
    transport: bindings.AI_GATEWAY ? "binding" : "url",
  };
  return {
    attemptDeadlineMs,
    started,
    controller,
    timer,
    deadline,
    diagnostic,
    httpStatus: undefined as number | undefined,
  };
}

type FourShogiAiAttempt = ReturnType<typeof startFourShogiAiAttempt>;

async function receiveFourShogiAiMove(
  bindings: AiServiceBindings,
  work: FourShogiAiWork,
  request: FourShogiMoveRequest,
  attempt: FourShogiAiAttempt,
) {
  const { url, requestId, revision, body } = request;
  const { signal } = attempt.controller;
  const response = await fetchAiGateway(bindings, new URL("/v1/four-shogi/move", url), {
    method: "POST",
    headers: {
      authorization: `Bearer ${bindings.AI_SERVICE_TOKEN}`,
      "content-type": "application/json",
      "x-tetraboard-ai-request-id": requestId,
      "x-tetraboard-ai-attempt": String(attempt.diagnostic.attempt),
    },
    body,
    redirect: "manual",
    signal,
  });
  if (signal.aborted) {
    void response.body?.cancel().catch(() => {});
    throw new ServiceError("attempt_timeout");
  }
  attempt.httpStatus = response.status;
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new ServiceError(
      `http_${response.status}`,
      response.status === 429 || response.status >= 500,
    );
  }
  const result = fourShogiMoveResponse.safeParse(await responseJson(response));
  if (
    !result.success ||
    result.data.request_id !== requestId ||
    result.data.position_revision !== revision ||
    result.data.engine_version !== work.profile.engineVersion ||
    result.data.profile_id !== work.profile.profileId ||
    result.data.max_work !== work.profile.work ||
    result.data.diagnostics.work > result.data.max_work
  )
    throw new ServiceError("invalid_response");
  return result.data.action;
}

function classifyFourShogiAiFailure(
  error: unknown,
  expiresAt: number,
  attemptDeadlineMs: number,
  httpStatus: number | undefined,
): { reason: FourShogiAiFailure; retryable: boolean } {
  const expired = Date.now() >= expiresAt;
  const attemptTimedOut =
    Date.now() >= attemptDeadlineMs ||
    (error instanceof ServiceError && error.reason === "attempt_timeout");
  if (expired || attemptTimedOut) return { reason: "timeout", retryable: !expired };
  if (
    error instanceof ServiceError &&
    httpStatus !== undefined &&
    (httpStatus < 200 || httpStatus >= 300)
  )
    return { reason: `http_${httpStatus}`, retryable: error.retryable };
  if (error instanceof ServiceError || error instanceof SyntaxError)
    return { reason: "invalid_response", retryable: false };
  return { reason: "network", retryable: true };
}

export async function requestFourShogiAiMove(
  bindings: AiServiceBindings,
  work: FourShogiAiWork,
): Promise<FourShogiAiResult> {
  const { requestId, roundId, positionRevision, expiresAt, side } = work.job;
  const url = configuredUrl(bindings);
  if (!url) return { action: null, reason: "configuration" };
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([roundId, positionRevision, side, work.events])),
  );
  const revision = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const body = createFourShogiAiRequest(work, side, requestId, revision);
  const request = { url, requestId, revision, body };

  for (let attempt = 1; ; attempt++) {
    const atMs = Date.now();
    const remaining = expiresAt - atMs;
    if (remaining <= 0) return { action: null, reason: "timeout" };
    const current = startFourShogiAiAttempt(bindings, roundId, requestId, attempt, atMs, remaining);
    const { attemptDeadlineMs, started, controller, timer, deadline, diagnostic } = current;
    try {
      const action = await Promise.race([
        receiveFourShogiAiMove(bindings, work, request, current),
        deadline,
      ]);
      if (Date.now() >= attemptDeadlineMs) throw new ServiceError("attempt_timeout");
      if (attempt === 2)
        logFourShogiDiagnostic(bindings, "four_shogi_ai_retry_response", {
          ...diagnostic,
          httpStatus: current.httpStatus ?? 200,
          elapsedMs: Math.round(performance.now() - started),
        });
      return { action, ...(attempt === 2 ? { retried: true as const } : {}) };
    } catch (error) {
      const { httpStatus } = current;
      const { reason, retryable } = classifyFourShogiAiFailure(
        error,
        expiresAt,
        attemptDeadlineMs,
        httpStatus,
      );
      const willRetry = retryable && attempt === 1 && Date.now() < expiresAt;
      logFourShogiDiagnostic(bindings, "four_shogi_ai_attempt_failed", {
        ...diagnostic,
        ...(httpStatus === undefined ? {} : { httpStatus }),
        elapsedMs: Math.round(performance.now() - started),
        reason,
        willRetry,
      });
      if (!willRetry) return { action: null, reason };
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
}
