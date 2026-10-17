import type { FourShogiAction, Side, Piece, Elimination, GameResult } from "./types";
import type { EvaluationWeights } from "./cpuEvaluation";
import type { AiModelEvaluator } from "./aiModel";

export type AiVersions = Readonly<{
  analysisVersion: string;
  engineVersion: string;
  searchVersion: string;
  evaluationVersion: string;
  featureVersion: string | null;
  actionVersion: string;
  opponentModelId: string;
  tieBreak: string;
  seed: number | null;
}>;

export const aiVersions: AiVersions = Object.freeze({
  analysisVersion: "singles-analysis-v2",
  engineVersion: "tetraboard-four-shogi-rules-v1",
  searchVersion: "selective-maxn-v2",
  evaluationVersion: "sole-first-heuristic-v2",
  featureVersion: null,
  actionVersion: "four-shogi-action-v1",
  opponentModelId: "selfish-maxn-v1",
  tieBreak: "legal-order",
  seed: null,
});
export type AiSearchSettings = Readonly<{
  timeBudgetMs: number | null;
  maxWork: number;
  maxDepth: number;
  width: number;
  rootWidth: number;
  extensions: number;
  candidateCount: number;
  includeAction: FourShogiAction | null;
  algorithm: "maxn" | "mcts";
  cacheSize: number;
  moveOrdering: "tactical" | "previous";
  evaluationWeights: EvaluationWeights;
  exploration: number;
  rolloutPlies: number;
  maxSimulations: number;
  seed: number;
  dangerWork: number;
  dangerPlies: number;
  modelTimeoutMs?: number;
}>;
export type AiOptions = Readonly<
  Partial<Omit<AiSearchSettings, "evaluationWeights">> & {
    codeVersion: string;
    modelId?: string | null;
    evaluationWeights?: Partial<EvaluationWeights>;
  }
>;
export type AiValue = Readonly<{
  primary: number;
  secondaryRank: number;
  heuristicScore: number | null;
}>;
export type AiEvaluation = Readonly<{
  evaluationKind: "heuristic" | "terminal" | "sample_mean" | "model";
  values: Readonly<Record<Side, AiValue>>;
  ranks: readonly Readonly<{ side: Side; rank: number; kind: "provisional" | "confirmed" }>[];
  probabilities: null;
}>;
export type AiLineStep = Readonly<{
  side: Side;
  action: FourShogiAction;
  afterPly: number;
  nextTurn: Side | null;
  checkedSides: readonly Side[];
  captured: Piece | null;
  eliminations: readonly Elimination[];
  result: GameResult | null;
}>;
export type AiCandidate = Readonly<{
  action: FourShogiAction;
  evaluation: AiEvaluation | null;
  completedDepth: number;
  iterationNodes: number;
  iterationWork: number;
  selective: boolean;
  cutoff: boolean;
  comparisonKind: "uniform_depth" | "sample_mean";
  visits: number;
  lineEvaluation: AiEvaluation | null;
  line: readonly AiLineStep[];
  danger: Readonly<{
    kind: "pv_example";
    forced: false;
    untilNextOwnTurn: "returned" | "terminal" | "eliminated" | "horizon";
    evidence: readonly AiLineStep[];
    alternatives: Readonly<AiAlternativeRisk> | null;
  }>;
}>;
export type AiAlternativeRisk = {
  kind: "possible_legal_replies";
  complete: boolean;
  limit: "work_limit" | "ply_limit" | "interrupted" | null;
  work: number;
  nodes: number;
  eliminationWitness: readonly AiLineStep[] | null;
  rookLossWitness: readonly AiLineStep[] | null;
};
export type AiStopReason =
  | "terminal"
  | "no_legal_actions"
  | "cancelled"
  | "deadline"
  | "work_limit"
  | "max_depth"
  | "simulation_limit"
  | "sole_win";
export type AiSearchStats = {
  work: number;
  nodes: number;
  generatedMoves: number;
  evaluations: number;
  completedDepth: number;
  extendedNodes: number;
  cacheEntries: number;
  legalCacheHits: number;
  transitionCacheHits: number;
  evaluationCacheHits: number;
  orderingCacheHits: number;
  simulations: number;
  maxVisitedPly: number;
};
export type AiProgress = Readonly<
  AiSearchStats & {
    elapsedMs: number;
    candidates: readonly AiCandidate[];
  }
>;
export type AiResult = Readonly<{
  schemaVersion: 1;
  status: "completed" | "limited" | "cancelled" | "terminal" | "no_legal_actions";
  input: Readonly<{
    stateHash: string;
    eventOffset: number;
    ruleProfileId: string;
    rulesVersion: 1;
    threePlayerAttackProhibited: boolean;
    rootSide: Side | null;
  }>;
  cacheKey: string;
  versions: AiVersions & Readonly<{ codeVersion: string }>;
  settings: AiSearchSettings;
  model: Readonly<{
    requestedModelId: string | null;
    loadedModelId: string | null;
    usedModelId: string | null;
    inferenceCount: number;
    inferenceCalls?: number;
    attemptedInferenceCount?: number;
    policyUses?: number;
    valueUses?: number;
    inferenceMs?: number;
    discardedWork?: number;
    fallbackReason?: string | null;
    fallbackDetail?: string | null;
  }>;
  recommendedAction: FourShogiAction | null;
  staticEvaluation: AiEvaluation;
  evaluation: AiEvaluation | null;
  currentDanger: Readonly<{ checkedSides: readonly Side[]; eliminations: readonly Elimination[] }>;
  candidates: readonly AiCandidate[];
  comparedAction: AiCandidate | null;
  diagnostics: Omit<AiProgress, "candidates"> &
    Readonly<{
      stopReason: AiStopReason;
      fallbackReason: "no_completed_iteration" | null;
      legalPreparationMs: number;
      deadlineOverrunMs: number;
      yields: number;
      algorithm: "maxn" | "mcts";
    }>;
}>;
export type AiControl = Readonly<{
  modelEvaluator?: AiModelEvaluator;
  modelLoadError?: string;
  signal?: AbortSignal;
  isCancelled?: () => boolean;
  now?: () => number;
  yieldToHost?: () => Promise<void>;
  onProgress?: (progress: AiProgress) => void;
}>;
