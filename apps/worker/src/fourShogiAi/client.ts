import {
  aiJobSnapshotSchema,
  aiServiceHealthSchema,
  aiModelIdSchema,
  aiCodeVersionSchema,
  aiJobRequestSchema,
  aiRequestFingerprint,
  type AiJobRequest,
} from "@tetraboard/protocol/four-shogi-ai";
import { readLimitedBody } from "../feedback/images";
import type { AuthEnv } from "../accounts/auth";

export type AiGatewayEnv = AuthEnv & {
  FOUR_SHOGI_AI_URL?: string;
  FOUR_SHOGI_AI_SHARED_SECRET?: string;
  FOUR_SHOGI_AI_ACCOUNT_IDS?: string;
  FOUR_SHOGI_AI_MODEL_ID?: string;
  FOUR_SHOGI_AI_CODE_VERSION?: string;
};
export class AiGatewayError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 429 | 503,
    readonly retryAfter = 0,
  ) {
    super(code);
  }
}
export function gatewayConfig(env: AiGatewayEnv) {
  const origin = new URL(env.APP_ORIGIN);
  if (
    !(
      origin.origin === "https://tetraboard-dev.chaossi-lab.workers.dev" ||
      (origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))
    )
  )
    throw new AiGatewayError("trial_disabled", 403);
  let ids: unknown;
  try {
    ids = JSON.parse(env.FOUR_SHOGI_AI_ACCOUNT_IDS ?? "null");
  } catch {
    throw new AiGatewayError("trial_unconfigured", 503);
  }
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    ids.length > 32 ||
    !ids.every((v) => typeof v === "string" && v.length > 0 && v.length <= 200 && v.trim() === v)
  )
    throw new AiGatewayError("trial_unconfigured", 503);
  const secret = env.FOUR_SHOGI_AI_SHARED_SECRET;
  if (
    !secret ||
    secret.length < 32 ||
    secret.length > 256 ||
    /\s/.test(secret) ||
    secret.startsWith("replace-") ||
    !env.FOUR_SHOGI_AI_URL ||
    !aiModelIdSchema.safeParse(env.FOUR_SHOGI_AI_MODEL_ID).success ||
    !aiCodeVersionSchema.safeParse(env.FOUR_SHOGI_AI_CODE_VERSION).success
  )
    throw new AiGatewayError("trial_unconfigured", 503);
  const url = new URL(env.FOUR_SHOGI_AI_URL);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" &&
      !(
        origin.protocol === "http:" &&
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  )
    throw new AiGatewayError("trial_unconfigured", 503);
  return {
    ids: ids as string[],
    secret,
    url: url.origin,
    modelId: env.FOUR_SHOGI_AI_MODEL_ID!,
    codeVersion: env.FOUR_SHOGI_AI_CODE_VERSION!,
  };
}
export async function aiPrincipal(env: AiGatewayEnv, id: string) {
  const { secret } = gatewayConfig(env);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return [
    ...new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode("four-shogi-ai-trial-v1:" + id),
      ),
    ),
  ]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}
export async function fetchAiService(
  env: AiGatewayEnv,
  path: string,
  init: RequestInit = {},
  principal?: string,
  instance?: string,
) {
  const config = gatewayConfig(env);
  try {
    const response = await fetch(config.url + path, {
      ...init,
      redirect: "error",
      signal: init.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(3000)])
        : AbortSignal.timeout(3000),
      headers: {
        Authorization: "Bearer " + config.secret,
        "Content-Type": "application/json",
        ...(principal ? { "X-AI-Principal": principal } : {}),
        ...(instance ? { "X-AI-Instance": instance } : {}),
      },
    });
    const bytes = await readLimitedBody(response, 2097152);
    if (!bytes) throw new AiGatewayError("ai_response_size", 503);
    const data: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!response.ok) {
      const code = (data as { error?: unknown })?.error;
      const allowed = [
        "invalid_request",
        "budget_limit",
        "request_conflict",
        "model_mismatch",
        "code_mismatch",
        "service_restarted",
        "request_expired",
        "expired",
        "job_not_found",
        "usage_limit",
        "pending_limit",
        "queue_full",
        "job_capacity",
      ];
      const status = [400, 404, 409, 410, 413, 429].includes(response.status)
        ? (response.status as 400 | 404 | 409 | 410 | 413 | 429)
        : 503;
      throw new AiGatewayError(
        typeof code === "string" && allowed.includes(code) ? code : "ai_unavailable",
        status,
        status === 429
          ? Math.min(600, Math.max(1, Number(response.headers.get("retry-after")) || 1))
          : 0,
      );
    }
    return { data, status: response.status };
  } catch (error) {
    if (error instanceof AiGatewayError) throw error;
    throw new AiGatewayError("ai_unavailable", 503);
  }
}
export async function aiHealth(env: AiGatewayEnv) {
  const config = gatewayConfig(env),
    { data } = await fetchAiService(env, "/v1/health");
  const health = aiServiceHealthSchema.safeParse(data);
  if (
    !health.success ||
    health.data.modelId !== config.modelId ||
    health.data.codeVersion !== config.codeVersion
  )
    throw new AiGatewayError("ai_version_mismatch", 503);
  return health.data;
}
export async function submitAiJob(env: AiGatewayEnv, request: AiJobRequest, signal?: AbortSignal) {
  request = aiJobRequestSchema.parse(request);
  const config = gatewayConfig(env);
  if (
    request.modelId !== config.modelId ||
    request.codeVersion !== config.codeVersion ||
    request.budget.timeBudgetMs > (request.context.kind === "cpu" ? 500 : 30000) ||
    request.budget.maxWork > (request.context.kind === "cpu" ? 32768 : 1000000)
  )
    throw new AiGatewayError("invalid_request", 400);
  const { data, status } = await fetchAiService(env, "/v1/jobs", {
    method: "POST",
    body: JSON.stringify(request),
    signal,
  });
  const snapshot = validatedSnapshot(env, data, request.serviceInstanceId);
  if (
    snapshot.requestId !== request.requestId ||
    snapshot.stateHash !== request.stateHash ||
    snapshot.inputHash !== (await aiRequestFingerprint(request)) ||
    JSON.stringify(snapshot.context) !== JSON.stringify(request.context)
  )
    throw new AiGatewayError("ai_response_mismatch", 503);
  return { snapshot, status: status === 202 ? (202 as const) : (200 as const) };
}
export function validatedSnapshot(env: AiGatewayEnv, value: unknown, instance: string) {
  const config = gatewayConfig(env),
    parsed = aiJobSnapshotSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.serviceInstanceId !== instance ||
    parsed.data.codeVersion !== config.codeVersion ||
    parsed.data.modelId !== config.modelId
  )
    throw new AiGatewayError("ai_response_mismatch", 503);
  if (parsed.data.status === "completed") {
    const result = parsed.data.result as {
      input?: { stateHash?: string };
      versions?: { codeVersion?: string };
      evaluation?: { probabilities?: unknown };
    } | null;
    if (
      !result ||
      result.input?.stateHash !== parsed.data.stateHash ||
      result.versions?.codeVersion !== config.codeVersion ||
      result.evaluation?.probabilities !== null
    )
      throw new AiGatewayError("ai_response_mismatch", 503);
  } else if (parsed.data.result !== null) throw new AiGatewayError("ai_response_mismatch", 503);
  return parsed.data;
}
