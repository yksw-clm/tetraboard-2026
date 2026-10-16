import { z } from "zod";
import {
  fourShogiActionSchema,
  fourShogiSideSchema,
  fourShogiPieceSchema,
  fourShogiEliminationSchema,
  fourShogiGameResultSchema,
} from "./fourShogi";

const count = z.int().nonnegative();
const id = z.string().max(160);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const sides = <T extends z.ZodType>(value: T) =>
  z.strictObject({ south: value, west: value, north: value, east: value });
const sideList = z
  .array(fourShogiSideSchema)
  .max(4)
  .refine((v) => new Set(v).size === v.length);
const evaluation = z.strictObject({
  evaluationKind: z.enum(["heuristic", "terminal", "sample_mean", "model"]),
  values: sides(
    z.strictObject({
      primary: z.number().min(0).max(1),
      secondaryRank: z.number().min(1).max(4),
      heuristicScore: z.number().nullable(),
    }),
  ),
  ranks: z
    .array(
      z.strictObject({
        side: fourShogiSideSchema,
        rank: z.int().min(1).max(4),
        kind: z.enum(["provisional", "confirmed"]),
      }),
    )
    .length(4)
    .refine((v) => new Set(v.map((r) => r.side)).size === 4),
  probabilities: z.null(),
});
const step = z.strictObject({
  side: fourShogiSideSchema,
  action: fourShogiActionSchema,
  afterPly: count,
  nextTurn: fourShogiSideSchema.nullable(),
  checkedSides: sideList,
  captured: fourShogiPieceSchema.nullable(),
  eliminations: z.array(fourShogiEliminationSchema).max(4),
  result: fourShogiGameResultSchema.nullable(),
});
const line = z.array(step).max(128);
const candidate = z.strictObject({
  action: fourShogiActionSchema,
  evaluation: evaluation.nullable(),
  completedDepth: count.max(64),
  iterationNodes: count,
  iterationWork: count,
  selective: z.boolean(),
  cutoff: z.boolean(),
  comparisonKind: z.enum(["uniform_depth", "sample_mean"]),
  visits: count,
  lineEvaluation: evaluation.nullable(),
  line,
  danger: z.strictObject({
    kind: z.literal("pv_example"),
    forced: z.literal(false),
    untilNextOwnTurn: z.enum(["returned", "terminal", "eliminated", "horizon"]),
    evidence: line,
    alternatives: z
      .strictObject({
        kind: z.literal("possible_legal_replies"),
        complete: z.boolean(),
        limit: z.enum(["work_limit", "ply_limit", "interrupted"]).nullable(),
        work: count,
        nodes: count,
        eliminationWitness: line.nullable(),
        rookLossWitness: line.nullable(),
      })
      .nullable(),
  }),
});

// 表示で解釈する版付きフィールドを検査します。未使用の診断項目は境界で取り除きます。
export const aiAnalysisResultSchema = z.object({
  schemaVersion: z.literal(1),
  status: z.enum(["completed", "limited", "cancelled", "terminal", "no_legal_actions"]),
  input: z.strictObject({
    stateHash: hash,
    eventOffset: count.max(2048),
    ruleProfileId: z.literal("tetraboard-four-shogi-singles-v1"),
    rulesVersion: z.literal(1),
    threePlayerAttackProhibited: z.boolean(),
    rootSide: fourShogiSideSchema.nullable(),
  }),
  versions: z.strictObject({
    codeVersion: z.string().regex(/^[0-9a-f]{40}$/),
    analysisVersion: id,
    engineVersion: z.literal("tetraboard-four-shogi-rules-v1"),
    searchVersion: id,
    evaluationVersion: id,
    featureVersion: id.nullable(),
    actionVersion: id,
    opponentModelId: id,
    tieBreak: id,
    seed: z.number().nullable(),
  }),
  settings: z.object({
    timeBudgetMs: z.number().min(0).max(30000),
    maxWork: count.max(1000000),
    maxDepth: count.max(64),
    width: count,
    rootWidth: count,
    extensions: count,
    candidateCount: count.max(5),
    includeAction: fourShogiActionSchema.nullable(),
    algorithm: z.literal("maxn"),
    dangerWork: count,
  }),
  model: z.object({
    requestedModelId: id.nullable(),
    loadedModelId: id.nullable(),
    usedModelId: id.nullable(),
    inferenceCount: count,
    fallbackReason: id.nullable().optional(),
  }),
  recommendedAction: fourShogiActionSchema.nullable(),
  staticEvaluation: evaluation,
  evaluation: evaluation.nullable(),
  currentDanger: z.strictObject({
    checkedSides: sideList,
    eliminations: z.array(fourShogiEliminationSchema).max(4),
  }),
  candidates: z.array(candidate).max(5),
  comparedAction: candidate.nullable(),
  diagnostics: z.object({
    work: count,
    nodes: count,
    completedDepth: count.max(64),
    elapsedMs: z.number().nonnegative(),
    stopReason: z.enum([
      "terminal",
      "no_legal_actions",
      "cancelled",
      "deadline",
      "work_limit",
      "max_depth",
      "simulation_limit",
      "sole_win",
    ]),
    fallbackReason: z.enum(["no_completed_iteration"]).nullable(),
    deadlineOverrunMs: z.number().nonnegative(),
  }),
});
export type AiAnalysisResult = z.infer<typeof aiAnalysisResultSchema>;
export type AiAnalysisCandidate = z.infer<typeof candidate>;
export type AiAnalysisEvaluation = z.infer<typeof evaluation>;
