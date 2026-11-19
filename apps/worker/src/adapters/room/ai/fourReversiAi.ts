import type { Position } from "@tetraboard/four-reversi";
import { z } from "zod";
import type { ExternalCpuWork } from "../../../rooms/fourReversiProgress";
import {
  configuredUrl,
  fetchAiGateway,
  fourReversiAiServiceTimeout,
  responseJson,
  ServiceError,
  type AiServiceBindings,
} from "./aiService";
import { expectedProfileLimits, profileIdSchema, profileLimitsSchema } from "./aiServiceProfiles";
import { createFourReversiAiRequest } from "./fourReversiAiRequest";

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

type SelectedProfile = Parameters<typeof expectedProfileLimits>[0];

function configureFourReversiAiRequest(bindings: AiServiceBindings, work: ExternalCpuWork) {
  const token = bindings.AI_SERVICE_TOKEN;
  const selectedProfile = work.job.serviceProfile;
  if (selectedProfile && "configuration_error" in selectedProfile) return null;
  let expectedLimits: ReturnType<typeof expectedProfileLimits> = null;
  if (selectedProfile) {
    if (!selectedProfile.profile_hash) return null;
    try {
      expectedLimits = expectedProfileLimits(selectedProfile);
    } catch {
      return null;
    }
  }
  const url = configuredUrl(bindings);
  return url ? { token, selectedProfile, expectedLimits, url } : null;
}

function parseFourReversiAiPosition(
  data: unknown,
  request: ReturnType<typeof createFourReversiAiRequest>,
  expected: {
    requestId: string;
    revision: string;
    selectedProfile: SelectedProfile | undefined;
    expectedLimits: ReturnType<typeof expectedProfileLimits>;
  },
): Position {
  const { agentId, rulesetVersion, stateVersion } = request;
  const { requestId, revision, selectedProfile, expectedLimits } = expected;
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
  return parsed.data.position;
}

export async function requestAiMove(
  bindings: AiServiceBindings,
  work: ExternalCpuWork,
): Promise<{ position: Position | null; reason?: string }> {
  const configuration = configureFourReversiAiRequest(bindings, work);
  if (!configuration) return { position: null, reason: "configuration" };
  const { token, selectedProfile, expectedLimits, url } = configuration;
  const { requestId, expiresAt, ...context } = work.job;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(context)),
  );
  const revision = Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
  const request = createFourReversiAiRequest(work, revision);
  const expected = { requestId, revision, selectedProfile, expectedLimits };
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
            body: request.body,
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
        return { position: parseFourReversiAiPosition(data, request, expected) };
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
