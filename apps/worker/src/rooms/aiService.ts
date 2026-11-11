import { logFourShogiDiagnostic } from "../fourShogiDiagnostics";
import { fourShogiActionSchema, type Room } from "@tetraboard/protocol";
import type { FourShogiAiWork } from "./fourShogiProgress";
import { z } from "zod";
import type { ExternalCpuWork } from "./fourReversiProgress";
import type { Position } from "@tetraboard/four-reversi";
import {
  expectedProfileLimits,
  profileIdSchema,
  profileLimitsSchema,
  profileMetadata,
} from "./aiServiceProfiles";

export interface AiServiceBindings {
  AI_RATED_ONLY?: string;
  FOUR_SHOGI_DIAGNOSTICS?: string;
  AI_SERVICE_URL?: string;
  AI_GATEWAY?: Pick<Fetcher, "fetch">;
  AI_SERVICE_TOKEN?: string;
  AI_SERVICE_TIMEOUT_MS?: string;
  AI_FOUR_REVERSI_TIMEOUT_MS?: string;
  AI_SERVICE_LEVEL2_PROFILE?: string;
  AI_SERVICE_LEVEL2_LIMITS?: string;
  AI_SHOGI_ENABLED?: string;
  AI_REVERSI_ENABLED?: string;
}

export const roomAiAllowed = (bindings: AiServiceBindings, room: Room) => {
  const context = "matchmaking" in room ? room.matchmaking : undefined;
  // 二人ゲームの専用ルームはすべてレート戦で、旧四人ランダムマッチだけは対象外です。
  return (
    bindings.AI_RATED_ONLY !== "true" ||
    (!!context && (("rated" in context && context.rated === true) || "opponent" in context))
  );
};

export const aiServiceEnabled = (bindings: AiServiceBindings) =>
  Boolean(bindings.AI_GATEWAY || bindings.AI_SERVICE_URL);
export function aiServiceTimeout(bindings: AiServiceBindings): number {
  const value = Number(bindings.AI_SERVICE_TIMEOUT_MS || 5000);
  return Number.isInteger(value) && value >= 100 && value <= 5000 ? value : 5000;
}

export function fourReversiAiServiceTimeout(bindings: AiServiceBindings): number {
  const value = Number(bindings.AI_FOUR_REVERSI_TIMEOUT_MS);
  return Number.isInteger(value) && value >= 100 && value <= 10_000
    ? value
    : aiServiceTimeout(bindings);
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

const profileResponseSchema = responseSchema.extend({
  api_version: z.literal(2),
  ruleset_version: z.enum(["four-reversi-singles-v1", "four-reversi-singles-v2"]),
  state_version: z.union([z.literal(1), z.literal(2)]),
  agent_id: z.enum([
    "four-reversi-random-v1",
    "four-reversi-greedy-v1",
    "four-reversi-maxn-v1",
    "four-reversi-mcts-v1",
  ]),
  profile_id: profileIdSchema,
  profile_hash: z.string().regex(/^[a-f0-9]{64}$/),
  effective_limits: profileLimitsSchema.nullable(),
  reproducible: z.boolean(),
  diagnostics: z.strictObject({
    nodes: z.int().min(0).max(65536),
    completed_depth: z.int().min(0).max(6),
    interrupted: z.boolean(),
    mcts: z
      .strictObject({
        iterations_started: z.int().min(0).max(4096),
        trials: z.int().min(0).max(4096),
        max_tree_depth: z.int().min(0).max(56),
        stop_reason: z.enum(["terminal", "iteration_limit", "node_limit", "deadline"]),
      })
      .optional(),
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

function configuredUrl(bindings: AiServiceBindings): URL | null {
  const token = bindings.AI_SERVICE_TOKEN;
  if (!token || token.length < 32 || token.length > 256 || !/^[\x21-\x7e]+$/.test(token))
    return null;
  if (bindings.AI_GATEWAY) return new URL("https://ai-gateway.internal");

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
      url.hash
    )
      throw Error();
  } catch {
    return null;
  }
  return url;
}
export const aiServiceConfigured = (bindings: AiServiceBindings) =>
  configuredUrl(bindings) !== null;

export const shogiAiEnabled = (bindings: AiServiceBindings) =>
  bindings.AI_SHOGI_ENABLED === "true" && aiServiceConfigured(bindings);

function fetchAiGateway(bindings: AiServiceBindings, url: URL, init: RequestInit) {
  return bindings.AI_GATEWAY ? bindings.AI_GATEWAY.fetch(new Request(url, init)) : fetch(url, init);
}

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

export type ShogiAiWork = {
  job: { requestId: string; roundId: string; positionRevision: number; expiresAt: number };
  moves: string[];
  nodes?: number;
  standardBook?: boolean;
};

const shogiNodes = 256;
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
  const nodes = work.nodes ?? shogiNodes;
  const openingBook = work.standardBook && work.moves.length < 2 ? shogiStandardBook : undefined;
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
        nodes,
        moves: work.moves,
        opening_book: openingBook,
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

export async function requestAiMove(
  bindings: AiServiceBindings,
  work: ExternalCpuWork,
): Promise<{ position: Position | null; reason?: string }> {
  const token = bindings.AI_SERVICE_TOKEN;
  const selectedProfile = work.job.serviceProfile;
  if (selectedProfile && "configuration_error" in selectedProfile)
    return { position: null, reason: "configuration" };
  let expectedLimits: ReturnType<typeof expectedProfileLimits> = null;
  if (selectedProfile) {
    if (!selectedProfile.profile_hash) return { position: null, reason: "configuration" };
    try {
      expectedLimits = expectedProfileLimits(selectedProfile);
    } catch {
      return { position: null, reason: "configuration" };
    }
  }
  const url = configuredUrl(bindings);
  if (!url) return { position: null, reason: "configuration" };
  const { requestId, expiresAt, ...context } = work.job;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(context)),
  );
  const revision = Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
  const agentId = selectedProfile
    ? profileMetadata(selectedProfile.profile_id).config.agent_id
    : work.job.level === 1
      ? "four-reversi-random-v1"
      : "four-reversi-greedy-v1";
  const rulesetVersion = work.job.extendedRules
    ? "four-reversi-singles-v2"
    : "four-reversi-singles-v1";
  const stateVersion = work.job.extendedRules ? 2 : 1;
  const body = JSON.stringify({
    api_version: selectedProfile ? 2 : 1,
    game_id: "four-reversi",
    ruleset_version: rulesetVersion,
    state_version: stateVersion,
    request_id: requestId,
    position_revision: revision,
    ...(selectedProfile
      ? {
          profile_id: selectedProfile.profile_id,
          ...(selectedProfile.limits ? { limits: selectedProfile.limits } : {}),
        }
      : { agent_id: agentId }),
    seed: Number.parseInt(revision.slice(0, 8), 16),
    state: {
      board: work.game.board,
      ...(work.job.extendedRules ? { eliminatedColors: work.game.eliminatedColors } : {}),
      turn: work.game.turn,
      moveNumber: work.game.moveNumber,
      lastMove: work.game.lastMove,
      consecutivePasses: work.game.consecutivePasses,
    },
  });
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    Math.max(1, Math.min(fourReversiAiServiceTimeout(bindings), expiresAt - Date.now())),
  );
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetchAiGateway(
          bindings,
          new URL(selectedProfile ? "/v2/move" : "/v1/move", url),
          {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body,
            signal: controller.signal,
            redirect: "manual",
          },
        );
        if (!response.ok) {
          await response.body?.cancel();
          throw new ServiceError(
            `http_${response.status}`,
            response.status === 429 || response.status >= 500,
          );
        }
        const data = await responseJson(response);
        const parsed = selectedProfile
          ? profileResponseSchema.safeParse(data)
          : responseSchema.safeParse(data);
        if (
          !parsed.success ||
          parsed.data.request_id !== requestId ||
          parsed.data.position_revision !== revision ||
          parsed.data.agent_id !== agentId ||
          parsed.data.ruleset_version !== rulesetVersion ||
          parsed.data.state_version !== stateVersion
        )
          throw new ServiceError("invalid_response");
        if (selectedProfile) {
          const profile = profileResponseSchema.parse(data);
          const limits = profile.effective_limits;
          const mcts = profile.diagnostics.mcts;
          if (
            profile.profile_id !== selectedProfile.profile_id ||
            profile.profile_hash !== selectedProfile.profile_hash ||
            (selectedProfile.engine_version !== undefined &&
              profile.engine_version !== selectedProfile.engine_version) ||
            (limits === null) !== (expectedLimits === null) ||
            (["max_iterations", "max_nodes", "max_time_ms"] as const).some(
              (key) => limits?.[key] !== expectedLimits?.[key],
            ) ||
            profile.reproducible !== !limits?.max_time_ms ||
            (limits?.max_nodes !== undefined && profile.diagnostics.nodes > limits.max_nodes) ||
            (selectedProfile.limits?.max_nodes !== undefined &&
              (limits?.max_nodes ?? Infinity) > selectedProfile.limits.max_nodes) ||
            (selectedProfile.limits?.max_iterations !== undefined &&
              (limits?.max_iterations ?? Infinity) > selectedProfile.limits.max_iterations) ||
            limits?.max_time_ms !== selectedProfile.limits?.max_time_ms ||
            (agentId === "four-reversi-mcts-v1" &&
              (!mcts ||
                !limits?.max_iterations ||
                mcts.trials > mcts.iterations_started ||
                mcts.iterations_started > limits.max_iterations))
          )
            throw new ServiceError("invalid_response");
        }
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
  const body = JSON.stringify({
    api_version: 1,
    rules_version: 1,
    request_id: requestId,
    position_revision: revision,
    profile_id: work.profile.profileId,
    three_player_attack_prohibited: true,
    turn: side,
    events: work.events,
  });
  for (let attempt = 1; ; attempt++) {
    const atMs = Date.now();
    const remaining = expiresAt - atMs;
    if (remaining <= 0) return { action: null, reason: "timeout" };
    // 最初の通信が無応答でも、総期限内で同じ要求を再試行できる時間を残します。
    const budgetMs =
      attempt === 1 ? Math.min(2000, Math.max(1, Math.floor(remaining * 0.4))) : remaining;
    const attemptDeadlineMs = atMs + budgetMs;
    const started = performance.now();
    const controller = new AbortController();
    let httpStatus: number | undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new ServiceError("attempt_timeout"));
        controller.abort();
      }, budgetMs);
    });
    const receive = async () => {
      const response = await fetchAiGateway(bindings, new URL("/v1/four-shogi/move", url), {
        method: "POST",
        headers: {
          authorization: `Bearer ${bindings.AI_SERVICE_TOKEN}`,
          "content-type": "application/json",
          "x-tetraboard-ai-request-id": requestId,
          "x-tetraboard-ai-attempt": String(attempt),
        },
        body,
        redirect: "manual",
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => {});
        throw new ServiceError("attempt_timeout");
      }
      httpStatus = response.status;
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
    };
    const diagnostic = {
      matchId: roundId,
      requestId,
      attempt,
      atMs,
      budgetMs,
      transport: bindings.AI_GATEWAY ? "binding" : "url",
    };
    try {
      const action = await Promise.race([receive(), deadline]);
      if (Date.now() >= attemptDeadlineMs) throw new ServiceError("attempt_timeout");
      if (attempt === 2)
        logFourShogiDiagnostic(bindings, "four_shogi_ai_retry_response", {
          ...diagnostic,
          httpStatus: httpStatus ?? 200,
          elapsedMs: Math.round(performance.now() - started),
        });
      return { action, ...(attempt === 2 ? { retried: true as const } : {}) };
    } catch (error) {
      const expired = Date.now() >= expiresAt;
      const attemptTimedOut =
        Date.now() >= attemptDeadlineMs ||
        (error instanceof ServiceError && error.reason === "attempt_timeout");
      let reason: FourShogiAiFailure;
      let retryable = false;
      if (expired || attemptTimedOut) {
        reason = "timeout";
        retryable = !expired;
      } else if (
        error instanceof ServiceError &&
        httpStatus !== undefined &&
        (httpStatus < 200 || httpStatus >= 300)
      ) {
        reason = `http_${httpStatus}`;
        retryable = error.retryable;
      } else if (error instanceof ServiceError || error instanceof SyntaxError)
        reason = "invalid_response";
      else {
        reason = "network";
        retryable = true;
      }
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
