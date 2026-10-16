import { z } from "zod";
import {
  fourShogiActionSchema,
  fourShogiReplayEventSchema,
  fourShogiSideSchema,
} from "./fourShogi";

export const aiServiceVersion = 1;
export const aiEngineVersion = "tetraboard-four-shogi-rules-v1";
export const aiRequestWindowMs = 60000;
export const aiRequestIdSchema = z
  .string()
  .regex(/^(0|[1-9]\d{0,8}):[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
export const aiHashSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const aiCodeVersionSchema = z.string().regex(/^[0-9a-f]{40}$/);
export const aiModelIdSchema = z.string().regex(/^four-shogi-tiny-policy-value-v1:[0-9a-f]{64}$/);
export const aiPurposeSchema = z.enum(["cpu", "analysis"]);
export const aiReplaySchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    ruleProfileId: z.literal("tetraboard-four-shogi-singles-v1"),
    rulesVersion: z.literal(1),
    initial: z.strictObject({
      mode: z.literal("singles"),
      players: z.strictObject({
        south: z.literal("south"),
        west: z.literal("west"),
        north: z.literal("north"),
        east: z.literal("east"),
      }),
      threePlayerAttackProhibited: z.boolean(),
    }),
    events: z
      .array(z.strictObject({ index: z.int().nonnegative(), event: fourShogiReplayEventSchema }))
      .max(2048),
    eventOffset: z.int().min(0).max(2048),
  })
  .refine((v) => v.eventOffset <= v.events.length && v.events.every((e, i) => e.index === i));
export const aiJobContextSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("cpu"),
    roomId: z.string().min(1).max(80),
    instanceId: z.uuid(),
    matchId: z.uuid(),
    revision: z.int().nonnegative(),
    side: fourShogiSideSchema,
    deadlineAtMs: z.int().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal("analysis"),
    matchId: z.uuid(),
    eventOffset: z.int().min(0).max(2048),
  }),
]);
export const aiJobRequestSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    serviceInstanceId: z.uuid(),
    requestId: aiRequestIdSchema,
    principal: aiHashSchema,
    codeVersion: aiCodeVersionSchema,
    engineVersion: z.literal(aiEngineVersion),
    modelId: aiModelIdSchema.nullable(),
    stateHash: aiHashSchema,
    context: aiJobContextSchema,
    lifetimeMs: z.int().min(0).max(90000),
    budget: z.strictObject({
      timeBudgetMs: z.int().min(1).max(30000),
      maxWork: z.int().min(1).max(1000000),
    }),
    includeAction: fourShogiActionSchema.nullable().default(null),
    position: aiReplaySchema,
  })
  .refine((v) => v.context.kind !== "analysis" || v.context.eventOffset === v.position.eventOffset);
export type AiJobRequest = z.infer<typeof aiJobRequestSchema>;
export type AiPurpose = z.infer<typeof aiPurposeSchema>;
export type AiJobStatus = "queued" | "running" | "completed" | "cancelled" | "expired" | "failed";
export const aiJobSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  serviceInstanceId: z.uuid(),
  jobId: z.uuid(),
  requestId: aiRequestIdSchema,
  stateHash: aiHashSchema,
  inputHash: aiHashSchema,
  codeVersion: aiCodeVersionSchema,
  engineVersion: z.literal(aiEngineVersion),
  modelId: aiModelIdSchema.nullable(),
  context: aiJobContextSchema,
  status: z.enum(["queued", "running", "completed", "cancelled", "expired", "failed"]),
  error: z.string().max(64).nullable(),
  timing: z.strictObject({
    queueMs: z.number().nonnegative(),
    computeMs: z.number().nonnegative(),
    restoreMs: z.number().nonnegative(),
    searchMs: z.number().nonnegative(),
    inferenceMs: z.number().nonnegative(),
  }),
  // 共通AIの版付き結果をそのまま運び、表示側の解釈は共通APIの契約に従います。
  result: z.unknown().nullable(),
});
export type AiJobSnapshot = z.infer<typeof aiJobSnapshotSchema>;
export const aiTrialAnalysisSchema = z.strictObject({
  schemaVersion: z.literal(1),
  serviceInstanceId: z.uuid(),
  requestId: aiRequestIdSchema,
  matchId: z.uuid(),
  eventOffset: z.int().min(0).max(2048),
  stateHash: aiHashSchema,
  profile: z.enum(["trial-500ms", "trial-30000ms"]),
});
export const aiJobLookupSchema = z.strictObject({ serviceInstanceId: z.uuid(), jobId: z.uuid() });
export const aiServiceHealthSchema = z.strictObject({
  schemaVersion: z.literal(1),
  serviceInstanceId: z.uuid(),
  requestWindow: z.int().nonnegative(),
  codeVersion: aiCodeVersionSchema,
  engineVersion: z.literal(aiEngineVersion),
  modelId: aiModelIdSchema.nullable(),
  status: z.enum(["ready", "unavailable", "stopping"]),
  workers: z.int().min(2).max(4),
  running: z.int().min(0).max(4),
  queued: z.int().nonnegative(),
  cpuReserved: z.int().min(1).max(3),
  memory: z.strictObject({
    observedBytes: z.number().nonnegative(),
    peakBytes: z.number().nonnegative(),
    limitBytes: z.number().positive(),
  }),
});
export async function aiRequestFingerprint(input: AiJobRequest) {
  const bytes = new TextEncoder().encode(JSON.stringify(aiJobRequestSchema.parse(input)));
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
}
export function createAiRequestId(requestWindow: number) {
  if (!Number.isSafeInteger(requestWindow) || requestWindow < 0 || requestWindow > 999999999)
    throw new RangeError("Invalid AI request window");
  return `${requestWindow}:${crypto.randomUUID()}`;
}

export const aiCpuProfiles = {
  "trial-100ms": { timeBudgetMs: 100, maxWork: 8192 },
  "trial-500ms": { timeBudgetMs: 500, maxWork: 32768 },
} as const;
export const aiTrialCpuSchema = z.strictObject({
  instanceId: z.uuid(),
  token: z.string().regex(/^[0-9a-f]{64}$/),
  playerId: z.string().min(1).max(200),
  profile: z.enum(["trial-100ms", "trial-500ms"]).nullable(),
});
export type AiCpuProfile = keyof typeof aiCpuProfiles;

export {
  aiAnalysisResultSchema,
  type AiAnalysisResult,
  type AiAnalysisCandidate,
  type AiAnalysisEvaluation,
} from "./fourShogiAiAnalysis";
