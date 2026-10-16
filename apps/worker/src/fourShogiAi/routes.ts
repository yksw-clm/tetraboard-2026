import { Hono } from "hono";
import {
  aiJobLookupSchema,
  aiJobRequestSchema,
  aiTrialAnalysisSchema,
  aiTrialCpuSchema,
} from "@tetraboard/protocol/four-shogi-ai";
import { accountIdentity, type StoredProfile } from "../accounts/auth";
import { readStoredMatch } from "../accounts/matchDataContracts";
import { readShogiMatchReplayPage } from "../rooms/shogiMatchStore";
import { readLimitedBody } from "../feedback/images";
import {
  AiGatewayError,
  aiHealth,
  aiPrincipal,
  fetchAiService,
  gatewayConfig,
  submitAiJob,
  validatedSnapshot,
  type AiGatewayEnv,
} from "./client";

export const fourShogiAiRoutes = new Hono<{
  Bindings: AiGatewayEnv;
  Variables: { aiUser: StoredProfile };
}>();
fourShogiAiRoutes.use("/four-shogi-ai/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  if (c.req.method !== "GET" && c.req.header("Origin") !== c.env.APP_ORIGIN)
    throw new AiGatewayError("invalid_origin", 403);
  const config = gatewayConfig(c.env);
  const user = await accountIdentity(c.req.raw, c.env);
  if (!user) throw new AiGatewayError("login_required", 401);
  if (!user.profileCompleted || !config.ids.includes(user.id))
    throw new AiGatewayError("trial_forbidden", 403);
  c.set("aiUser", user);
  await next();
});
fourShogiAiRoutes.onError((error, c) => {
  const failed =
    error instanceof AiGatewayError ? error : new AiGatewayError("ai_unavailable", 503);
  if (failed.retryAfter) c.header("Retry-After", String(failed.retryAfter));
  return c.json({ error: failed.code }, failed.status);
});
fourShogiAiRoutes.get("/four-shogi-ai/health", async (c) => c.json(await aiHealth(c.env)));
fourShogiAiRoutes.post("/four-shogi-ai/jobs", async (c) => {
  const bytes = await readLimitedBody(c.req.raw, 2048);
  if (!bytes) throw new AiGatewayError("request_size_limit", 413);
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new AiGatewayError("invalid_request", 400);
  }
  const parsed = aiTrialAnalysisSchema.safeParse(raw);
  if (!parsed.success) throw new AiGatewayError("invalid_request", 400);
  const input = parsed.data;
  const row = await c.env.APP_DB.prepare("SELECT game, record_json FROM matches WHERE id = ?")
    .bind(input.matchId)
    .first<{ game: string; record_json: string }>();
  if (!row || row.game !== "four-shogi") throw new AiGatewayError("match_not_found", 404);
  const match = readStoredMatch(row.record_json, row.game);
  if (
    match.game !== "four-shogi" ||
    match.record.game.status !== "finished" ||
    match.record.replay.initial.mode !== "singles"
  )
    throw new AiGatewayError("unsupported_match", 400);
  if (input.eventOffset > match.record.replay.eventCount)
    throw new AiGatewayError("invalid_offset", 400);
  const events = [];
  for (let cursor = 0; cursor < input.eventOffset;) {
    const page = await readShogiMatchReplayPage(c.env.APP_DB, input.matchId, cursor, "four-shogi");
    if (!page || page.events.length === 0) throw new AiGatewayError("invalid_replay", 503);
    events.push(...page.events.slice(0, input.eventOffset - cursor));
    cursor += page.events.length;
  }
  const config = gatewayConfig(c.env);
  const request = aiJobRequestSchema.parse({
    schemaVersion: 1,
    serviceInstanceId: input.serviceInstanceId,
    requestId: input.requestId,
    principal: await aiPrincipal(c.env, c.get("aiUser").id),
    codeVersion: config.codeVersion,
    engineVersion: "tetraboard-four-shogi-rules-v1",
    modelId: config.modelId,
    stateHash: input.stateHash,
    context: { kind: "analysis", matchId: input.matchId, eventOffset: input.eventOffset },
    lifetimeMs: 45000,
    budget: { timeBudgetMs: input.profile === "trial-500ms" ? 500 : 30000, maxWork: 1000000 },
    position: {
      schemaVersion: 1,
      rulesVersion: 1,
      ruleProfileId: "tetraboard-four-shogi-singles-v1",
      initial: {
        mode: "singles",
        players: { south: "south", west: "west", north: "north", east: "east" },
        threePlayerAttackProhibited: match.record.replay.initial.threePlayerAttackProhibited,
      },
      events,
      eventOffset: input.eventOffset,
    },
  });
  const { snapshot, status } = await submitAiJob(c.env, request);
  return c.json(snapshot, status);
});
fourShogiAiRoutes.on(["GET", "DELETE"], "/four-shogi-ai/jobs/:jobId", async (c) => {
  const parsed = aiJobLookupSchema.safeParse({
    jobId: c.req.param("jobId"),
    serviceInstanceId: c.req.query("serviceInstanceId"),
  });
  if (!parsed.success) throw new AiGatewayError("invalid_request", 400);
  const principal = await aiPrincipal(c.env, c.get("aiUser").id);
  const { data } = await fetchAiService(
    c.env,
    "/v1/jobs/" + parsed.data.jobId,
    { method: "GET" },
    principal,
    parsed.data.serviceInstanceId,
  );
  const result = validatedSnapshot(c.env, data, parsed.data.serviceInstanceId);
  if (result.jobId !== parsed.data.jobId || result.context.kind !== "analysis")
    throw new AiGatewayError("job_not_found", 404);
  if (c.req.method === "DELETE") {
    const cancelled = await fetchAiService(
      c.env,
      "/v1/jobs/" + parsed.data.jobId,
      { method: "DELETE" },
      principal,
      parsed.data.serviceInstanceId,
    );
    const snapshot = validatedSnapshot(c.env, cancelled.data, parsed.data.serviceInstanceId);
    if (
      snapshot.jobId !== result.jobId ||
      snapshot.requestId !== result.requestId ||
      snapshot.inputHash !== result.inputHash ||
      snapshot.context.kind !== "analysis"
    )
      throw new AiGatewayError("ai_response_mismatch", 503);
    return c.json(snapshot);
  }
  return c.json(result);
});

fourShogiAiRoutes.post("/four-shogi-ai/rooms/:roomId/cpu", async (c) => {
  const bytes = await readLimitedBody(c.req.raw, 2048);
  if (!bytes) throw new AiGatewayError("request_size_limit", 413);
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new AiGatewayError("invalid_request", 400);
  }
  const parsed = aiTrialCpuSchema.safeParse(raw);
  if (!parsed.success || !/^\d{5}$/.test(c.req.param("roomId")))
    throw new AiGatewayError("invalid_request", 400);
  const input = parsed.data;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input.token));
  const hash = [...new Uint8Array(digest)].map((n) => n.toString(16).padStart(2, "0")).join("");
  const result = await (c.env as Env).GAME_ROOM.getByName(c.req.param("roomId")).configureTrialCpu(
    c.get("aiUser").id,
    hash,
    input.instanceId,
    input.playerId,
    input.profile,
  );
  if ("error" in result)
    throw new AiGatewayError(
      result.error!,
      result.error === "room_not_found" ? 404 : result.error === "trial_forbidden" ? 403 : 409,
    );
  return c.json(result);
});
fourShogiAiRoutes.get("/four-shogi-ai/rooms/:roomId/cpu-diagnostics", async (c) => {
  const instance = aiTrialCpuSchema.shape.instanceId.safeParse(c.req.query("instanceId"));
  if (!instance.success || !/^\d{5}$/.test(c.req.param("roomId")))
    throw new AiGatewayError("invalid_request", 400);
  const result = await (c.env as Env).GAME_ROOM.getByName(
    c.req.param("roomId"),
  ).trialCpuDiagnostics(c.get("aiUser").id, instance.data);
  if (!result) throw new AiGatewayError("room_not_found", 404);
  return c.json({ diagnostics: result });
});
