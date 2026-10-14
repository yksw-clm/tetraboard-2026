import type { FourShogiAction, Side, Piece, Elimination, GameResult } from "./types";

export const aiVersions = Object.freeze({
  analysisVersion: "singles-analysis-v1",
  engineVersion: "tetraboard-four-shogi-rules-v1",
  searchVersion: "selective-maxn-v1",
  evaluationVersion: "sole-first-heuristic-v1",
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
}>;
export type AiOptions = Readonly<{
  codeVersion: string;
  modelId?: null;
  timeBudgetMs?: number | null;
  maxWork?: number;
  maxDepth?: number;
  width?: number;
  rootWidth?: number;
  extensions?: number;
  candidateCount?: number;
  includeAction?: FourShogiAction | null;
}>;
export type AiValue = Readonly<{
  primary: number;
  secondaryRank: number;
  heuristicScore: number | null;
}>;
export type AiEvaluation = Readonly<{
  evaluationKind: "heuristic" | "terminal";
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
  line: readonly AiLineStep[];
  danger: Readonly<{
    kind: "pv_example";
    forced: false;
    untilNextOwnTurn: "returned" | "terminal" | "eliminated" | "horizon";
    evidence: readonly AiLineStep[];
  }>;
}>;
export type AiStopReason =
  | "terminal"
  | "no_legal_actions"
  | "cancelled"
  | "deadline"
  | "work_limit"
  | "max_depth"
  | "sole_win";
export type AiProgress = Readonly<{
  work: number;
  nodes: number;
  generatedMoves: number;
  evaluations: number;
  completedDepth: number;
  extendedNodes: number;
  elapsedMs: number;
  candidates: readonly AiCandidate[];
}>;
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
  versions: typeof aiVersions & Readonly<{ codeVersion: string }>;
  settings: AiSearchSettings;
  model: Readonly<{
    requestedModelId: null;
    loadedModelId: null;
    usedModelId: null;
    inferenceCount: 0;
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
      algorithm: "maxn";
    }>;
}>;
export type AiControl = Readonly<{
  signal?: AbortSignal;
  isCancelled?: () => boolean;
  now?: () => number;
  yieldToHost?: () => Promise<void>;
  onProgress?: (progress: AiProgress) => void;
}>;
