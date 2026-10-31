import { getAnalysisLegalActions, type AnalysisPosition } from "./analysis";
import { compareAiValue, evaluateAiPosition } from "./aiEvaluation";
import { resolveAiOptions } from "./ai";
import {
  createAiContext,
  makeAiCandidate,
  type AiBranch,
  type AiContext,
  type AiContextMetrics,
  type AiAdvance,
} from "./aiSearchContext";
import { getCheckState, pieces, attacksSquare } from "./board";
import { priority } from "./cpuSearch";
import {
  studyCheckingRays,
  studyQuiescenceReason,
  selectStudyQuiescenceMoves,
} from "./studyTacticalSelection";
import {
  studyTraceAction,
  type StudySearchDiagnostics,
  type StudyTraceEvent,
  type StudyTraceNode,
  type StudySelectionRow,
} from "./studyDiagnostics";
export type { StudySearchDiagnostics, StudyTraceEvent } from "./studyDiagnostics";
import {
  pieceValue,
  evaluatePosition,
  defaultEvaluationWeights,
  type EvaluationBreakdown,
} from "./cpuEvaluation";
import type { OrdinaryMove } from "./moves";
import { getActiveSides, handPieceKinds, sides, type FourShogiState, type Side } from "./types";
import type {
  AiAlternativeRisk,
  AiCandidate,
  AiEvaluation,
  AiLineStep,
  AiSearchStats,
} from "./aiTypes";

function keepBranch(branch: AiBranch, _reason?: string) {
  return branch;
}

export const studySearchVersion = "local-root-maxn-v6";
export const adaptiveStudySearchVersion = "local-root-maxn-v5";
export const legacyStudySearchVersion = "local-root-maxn-v4";
export const studySearchStrategies = [
  "legacy",
  "adaptive",
  "dual",
  "dual-promotions",
  "dual-extensions",
  "dual-combined",
  "dual-continuations",
  "dual-quiescent",
  "dual-refined",
] as const;
export type StudySearchStrategy = (typeof studySearchStrategies)[number];
export function isDualStudyStrategy(strategy?: string): boolean {
  return (
    strategy !== undefined &&
    [
      "dual",
      "dual-promotions",
      "dual-extensions",
      "dual-combined",
      "dual-continuations",
      "dual-quiescent",
      "dual-refined",
    ].includes(strategy)
  );
}
export function studyStrategyVersion(strategy?: StudySearchStrategy): string {
  if (strategy === "dual-quiescent") return "local-root-maxn-v6-p0-6";
  if (strategy === "dual-refined") return "local-root-maxn-v6-p0-56";
  if (strategy === "dual-continuations") return "local-root-maxn-v6-p0-5";
  if (strategy === "dual-extensions") return "local-root-maxn-v6-p0-3";
  if (strategy === "dual-combined") return "local-root-maxn-v6-p0-23";
  return strategy === "dual-promotions"
    ? "local-root-maxn-v6-p0-2"
    : strategy === "dual"
      ? studySearchVersion
      : strategy === "legacy"
        ? legacyStudySearchVersion
        : adaptiveStudySearchVersion;
}
export type StudyTaskPolicy = { phase: "broad" | "deep"; width: number; ownWidth: number };
/** 元の文脈の反復履歴を参照する差分状態です。新しい検討局面として復元しません。 */
export type StudySubtreeTask = {
  slot: number;
  baseStateHash: string;
  rootIndex: number;
  targetDepth: number;
  policy: StudyTaskPolicy;
  state: FourShogiState;
  remaining: number;
  extra: number;
  ply: number;
};
export type StudySubtreeResult = { slot: number; branch: AiBranch; work: number; nodes: number };
export type StudySplitPlan = { planId: number; tasks: StudySubtreeTask[] };
export const studyEvaluationVersion = "local-sole-first-pressure-v1";
export type StudyProfile = "study" | "baseline";
export type StudyEngagement = { attacker: Side; target: Side; pressure: number };
export type StudyMaterialEvidence = {
  initialAssets: number;
  lineDelta: number;
  lossWitness: readonly AiLineStep[] | null;
  complete: boolean;
  limit: "work_limit" | "ply_limit" | "interrupted" | null;
};
export type StudyCandidate = AiCandidate & {
  rootIndex: number;
  study: {
    initialScore?: number;
    immediateLoss: readonly AiLineStep[] | null;
    immediateRepliesComplete: boolean;
    rightSide: Side | null;
    rightCheckPriority: boolean;
    magic: boolean;
    magicEvidence: {
      status: "candidate" | "line_confirmed";
      target: Side;
      returnedAtPly: number | null;
    } | null;
    material: StudyMaterialEvidence;
    engagements: readonly StudyEngagement[];
    explanations: readonly string[];
  };
};
export type StudyLaneSnapshot = {
  lane: number;
  depth: number;
  done: boolean;
  candidates: StudyCandidate[];
  staticEvaluation: AiEvaluation;
  stats: AiSearchStats;
  performance?: StudySearchPerformance;
};
export type StudySearchPerformance = AiContextMetrics & {
  contextCacheEntries?: number;
  contextCacheCapacity?: number;
  branchCacheHits: number;
  branchCacheEntries: number;
  keyMs: number;
  immediateWork: number;
  materialWork: number;
  reducedNodes: number;
  researches: number;
  promotionExtraMoves: number;
  checkingExtraMoves?: number;
  checkingReserveNodes?: number;
  extendedNodes?: number;
  quiescenceStops?: number;
  quiescenceMoves?: number;
  subtreeStateCacheHits?: number;
  subtreeStateCacheEntries?: number;
  subtreeStateKeyMs?: number;
  preparationWork?: number;
  rootSetupWork?: number;
};
export type StudyRootOptions = {
  subtreeCacheLimit?: number;
  reuseChecks?: boolean;
  measureDetails?: boolean;
  strategy?: StudySearchStrategy;
  lane?: number;
  lanes?: number;
  maxDepth?: number;
  width?: number;
  rootWidth?: number;
  extensions?: number;
  cacheSize?: number;
  dangerWork?: number;
  profile?: StudyProfile;
};

/** 画面回転や脱落によって、元の右隣を別の相手へ付け替えません。 */
export function studyRightSide(state: FourShogiState, side: Side): Side | null {
  const right = sides[(sides.indexOf(side) + sides.length - 1) % sides.length];
  return getActiveSides(state).includes(right) ? right : null;
}

function assets(state: FourShogiState, side: Side): number {
  if (!getActiveSides(state).includes(side)) return 0;
  return (
    pieces(state.board).reduce(
      (sum, entry) => sum + (entry.piece.side === side ? pieceValue(entry.piece) : 0),
      0,
    ) +
    handPieceKinds.reduce(
      (sum, kind) =>
        sum + state.hands[side][kind] * pieceValue({ id: -1, side, kind, promoted: false }),
      0,
    )
  );
}

function engagements(state: FourShogiState): StudyEngagement[] {
  const active = getActiveSides(state);
  const all = pieces(state.board).filter(({ piece }) => active.includes(piece.side));
  const pressure = Object.fromEntries(
    sides.map((a) => [a, Object.fromEntries(sides.map((b) => [b, 0]))]),
  ) as Record<Side, Record<Side, number>>;
  for (const target of all) {
    for (const attacker of all) {
      if (attacker.piece.side === target.piece.side || attacker.piece.kind === "king") continue;
      if (attacksSquare(state.board, attacker.piece, attacker.position, target.position)) {
        pressure[attacker.piece.side][target.piece.side] +=
          target.piece.kind === "king" ? 400 : Math.min(200, pieceValue(target.piece) * 0.2);
      }
    }
  }
  return active.flatMap((attacker) =>
    active
      .filter((target) => target !== attacker && pressure[attacker][target] > 0)
      .map((target) => ({ attacker, target, pressure: pressure[attacker][target] })),
  );
}

/** 利きによる圧力は戦略上の目安で、三人攻撃の合法性や相手の選択を断定しません。 */
function studyEvaluation(
  state: FourShogiState,
  observe?: (side: Side, engagement: number, skippedDefense: number) => void,
): AiEvaluation {
  const base = evaluateAiPosition(state);
  if (state.status === "finished") return base;
  const active = getActiveSides(state);
  const all = pieces(state.board).filter(({ piece }) => active.includes(piece.side));
  const relations = engagements(state);
  const pressure = (a: Side, b: Side) =>
    relations.find((entry) => entry.attacker === a && entry.target === b)?.pressure ?? 0;
  const checked = getCheckState(state);
  const values = { ...base.values };
  for (const side of active) {
    const opponents = active.filter((other) => other !== side);
    let engagement = 0;
    for (let a = 0; a < opponents.length; a++)
      for (let b = a + 1; b < opponents.length; b++) {
        const mutual = Math.min(
          pressure(opponents[a], opponents[b]),
          pressure(opponents[b], opponents[a]),
        );
        const ownExposure = Math.max(pressure(opponents[a], side), pressure(opponents[b], side));
        // 自王へ圧力が向く場合、第三者同士の争いによる余裕を見込みません。
        engagement += Math.max(0, mutual - ownExposure) * 0.06;
      }
    const forcedAway = active.some((other) => other !== side && checked[other]);
    let skippedDefense = 0;
    if (state.turn !== side && forcedAway) {
      for (const target of all.filter(
        ({ piece }) => piece.side === side && piece.kind !== "king",
      )) {
        const threats = all.filter(
          ({ piece, position }) =>
            piece.side !== side && attacksSquare(state.board, piece, position, target.position),
        );
        if (threats.length && !checked[side]) skippedDefense += pieceValue(target.piece) * 0.12;
      }
    }
    observe?.(side, Math.min(150, engagement), skippedDefense);
    const score = base.values[side].heuristicScore! + Math.min(150, engagement) - skippedDefense;
    values[side] = {
      ...values[side],
      heuristicScore: score,
      primary: Math.max(
        Number.EPSILON,
        Math.min(1 - Number.EPSILON, 0.5 + Math.atan(score / 10000) / Math.PI),
      ),
    };
  }
  for (const side of active)
    values[side] = {
      ...values[side],
      secondaryRank:
        1 + active.filter((other) => values[other].primary > values[side].primary).length,
    };
  return {
    ...base,
    values,
    ranks: base.ranks.map((entry) =>
      entry.kind === "confirmed" ? entry : { ...entry, rank: values[entry.side].secondaryRank },
    ),
  };
}

function lineAssets(state: FourShogiState, side: Side, line: readonly AiLineStep[]): number {
  let total = assets(state, side);
  const board = state.board.map((row) => [...row]);
  for (const step of line) {
    if (step.captured?.side === side) total -= pieceValue(step.captured);
    if (step.captured && step.side === side)
      total += pieceValue({ ...step.captured, promoted: false });
    const action = step.action;
    if (action.type === "movePiece") {
      const piece = board[action.from.y][action.from.x];
      if (piece) {
        const moved = { ...piece, promoted: piece.promoted || action.promote };
        if (piece.side === side) total += pieceValue(moved) - pieceValue(piece);
        board[action.to.y][action.to.x] = moved;
        board[action.from.y][action.from.x] = null;
      }
    } else
      board[action.to.y][action.to.x] = {
        id: -1,
        side: step.side,
        kind: action.pieceKind,
        promoted: false,
      };
    if (step.eliminations.some((entry) => entry.side === side)) return 0;
  }
  return total;
}

function probeMaterialReplies(
  ctx: AiContext,
  input: FourShogiState,
  first: AiLineStep,
  quota: number,
  initialAssets: number,
) {
  const result: AiAlternativeRisk = {
    kind: "possible_legal_replies",
    complete: false,
    limit: "interrupted",
    work: 0,
    nodes: 0,
    eliminationWitness: null,
    rookLossWitness: null,
  };
  const material: Pick<StudyMaterialEvidence, "lossWitness" | "complete" | "limit"> = {
    lossWitness: null,
    complete: false,
    limit: "interrupted",
  };
  const started = { work: ctx.stats.work, nodes: ctx.stats.nodes };
  let horizon = false;
  function* visit(state: FourShogiState, line: AiLineStep[]): Generator<number, void> {
    yield* ctx.spend(0);
    if (!getActiveSides(state).includes(ctx.root!)) {
      result.eliminationWitness ??= line;
      return;
    }
    if (assets(state, ctx.root!) < initialAssets) material.lossWitness ??= line;
    if (state.status === "finished" || state.turn === ctx.root) return;
    if (line.length >= ctx.settings.dangerPlies) {
      horizon = true;
      return;
    }
    const replies = yield* ctx.moves(state);
    const ordered = replies
      .map((move, index) => ({
        move,
        index,
        score: move.captured?.side === ctx.root ? pieceValue(move.captured) : 0,
      }))
      .sort((a, b) => b.score - a.score || a.index - b.index);
    // 取り返せる人へ仮の手番を渡さず、各着手の正本が返す実手番をたどります。
    for (const { move } of ordered) {
      const next = yield* ctx.advance(state, move, line.length);
      const path = [...line, next.step];
      if (next.step.captured?.side === ctx.root && next.step.captured.kind === "rook")
        result.rookLossWitness ??= path;
      yield* visit(next.state, path);
    }
  }
  function* run(): Generator<number, void> {
    const steps = visit(input, [first]);
    try {
      for (let next = steps.next(); !next.done; next = steps.next()) {
        if (ctx.stats.work - started.work + next.value > quota) {
          result.limit = material.limit = "work_limit";
          return;
        }
        yield next.value;
      }
      result.complete = material.complete = !horizon;
      result.limit = material.limit = horizon ? "ply_limit" : null;
    } finally {
      steps.return();
      result.work = ctx.stats.work - started.work;
      result.nodes = ctx.stats.nodes - started.nodes;
    }
  }
  return { result, material, steps: run() };
}

export function evaluateStudyPosition(position: AnalysisPosition): AiEvaluation {
  getAnalysisLegalActions(position); // Enforce the trusted-position boundary, including setups.
  return studyEvaluation(position.state);
}

/** 正本で作った診断局面に限定し、現行評価の計算過程を説明します。 */
export function explainStudyEvaluation(position: AnalysisPosition) {
  getAnalysisLegalActions(position);
  let base: EvaluationBreakdown | null = null;
  evaluatePosition(position.state, { ...defaultEvaluationWeights, survival: 0 }, (parts) => {
    base = parts;
  });
  const adjustments: Partial<Record<Side, { engagement: number; skippedDefense: number }>> = {};
  const evaluation = studyEvaluation(position.state, (side, engagement, skippedDefense) => {
    adjustments[side] = { engagement, skippedDefense };
  });
  return { base: base as EvaluationBreakdown | null, adjustments, evaluation };
}

function rightCheckBonus(
  state: FourShogiState,
  move: OrdinaryMove,
  checks = getCheckState,
): number {
  const right = studyRightSide(state, state.turn!);
  return right && !checks(state)[right] && checks(move.state)[right] ? 180 : 0;
}
export function compareStudyCandidates(a: StudyCandidate, b: StudyCandidate, root: Side): number {
  const terminalWin = (entry: StudyCandidate) =>
    Number(
      entry.evaluation?.evaluationKind === "terminal" &&
        entry.evaluation.values[root].primary === 1,
    );
  return (
    terminalWin(b) - terminalWin(a) ||
    Number(a.study.immediateLoss !== null) - Number(b.study.immediateLoss !== null) ||
    (a.evaluation && b.evaluation
      ? compareAiValue(b.evaluation.values[root], a.evaluation.values[root])
      : 0) ||
    (a.evaluation && b.evaluation
      ? Number(b.study.rightCheckPriority) - Number(a.study.rightCheckPriority)
      : 0) ||
    (b.study.initialScore ?? 0) - (a.study.initialScore ?? 0) ||
    a.rootIndex - b.rootIndex
  );
}

/** 評価深さは割当の優先度にだけ使い、異なる深さを完成比較として公開しません。 */
export function selectStudyIterationRoots(
  candidates: readonly StudyCandidate[],
  root: Side,
  depth: number,
  width = 24,
): number[] {
  const ordered = [...candidates].sort((a, b) => compareStudyCandidates(a, b, root));
  const quiet = ordered.filter(
    (entry) =>
      !entry.line[0]?.captured &&
      !entry.line[0]?.checkedSides.length &&
      !(entry.action.type === "movePiece" && entry.action.promote),
  );
  const count = Math.max(5, Math.ceil(width / Math.max(1, depth - 1)));
  const selected = new Set(
    ordered.filter((entry) => !quiet.includes(entry)).map((entry) => entry.rootIndex),
  );
  quiet.slice(0, count).forEach((entry) => selected.add(entry.rootIndex));
  const reserve = quiet.slice(count);
  // 下位候補も毎反復で巡回し、最初の静的評価だけで永久に除外しません。
  for (let offset = 0; offset < Math.min(2, reserve.length); offset++)
    selected.add(reserve[((depth - 2) * 2 + offset) % reserve.length].rootIndex);
  return ordered.filter((entry) => selected.has(entry.rootIndex)).map((entry) => entry.rootIndex);
}

export function studyBranchKey(state: FourShogiState, remaining: number, extra: number): string {
  return `${remaining}:${extra}:${JSON.stringify(state)}`;
}
export function selectStudyRootIndices(
  candidates: readonly StudyCandidate[],
  root: Side,
  width = 24,
): number[] {
  return [...candidates]
    .sort((a, b) => compareStudyCandidates(a, b, root))
    .filter(
      (candidate, index) =>
        index < width ||
        candidate.line[0]?.captured !== null ||
        (candidate.line[0]?.checkedSides.length ?? 0) > 0,
    )
    .map((candidate) => candidate.rootIndex);
}

/** 各プロセスは同じ完全状態から探索し、全候補の完成深さを呼出側でそろえます。 */
export function createStudyRootSearch(
  position: AnalysisPosition,
  options: StudyRootOptions = {},
  diagnostics?: StudySearchDiagnostics,
) {
  getAnalysisLegalActions(position);
  const lane = options.lane ?? 0;
  const lanes = options.lanes ?? 1;
  if (
    !Number.isSafeInteger(lanes) ||
    lanes < 1 ||
    lanes > 32 ||
    !Number.isSafeInteger(lane) ||
    lane < 0 ||
    lane >= lanes
  )
    throw new TypeError("探索レーンが不正です");
  const optimized = options.strategy !== "legacy";
  // 広いv5では20秒比較でRSS上限停止が増えたため、王手共有は明示指定だけにします。
  const reuseChecks = options.reuseChecks ?? isDualStudyStrategy(options.strategy);
  const preserveOwnPromotion =
    options.strategy === "dual-promotions" ||
    options.strategy === "dual-combined" ||
    options.strategy === "dual-continuations" ||
    options.strategy === "dual-refined";
  const preserveCheckingDiversity =
    options.strategy === "dual-continuations" || options.strategy === "dual-refined";
  const selectiveQuiescence =
    options.strategy === "dual-quiescent" || options.strategy === "dual-refined";
  const extendDeepLeaves =
    options.strategy === "dual-extensions" ||
    options.strategy === "dual-combined" ||
    diagnostics?.extendDeepLeaves ||
    selectiveQuiescence;
  const cacheSize = options.cacheSize ?? (optimized ? 4096 : 1024);
  if (!Number.isSafeInteger(cacheSize) || cacheSize < 0 || cacheSize > 65536)
    throw new TypeError("検討用キャッシュは0〜65536状態です");
  if (
    options.subtreeCacheLimit !== undefined &&
    (!optimized ||
      !Number.isSafeInteger(options.subtreeCacheLimit) ||
      options.subtreeCacheLimit < 0 ||
      options.subtreeCacheLimit > cacheSize)
  )
    throw new TypeError("独立応手キャッシュの保持枠が不正です");
  const settings = {
    ...resolveAiOptions({
      codeVersion: studySearchVersion,
      maxWork: Number.MAX_SAFE_INTEGER,
      maxDepth: options.maxDepth ?? 256,
      width: options.width ?? 6,
      rootWidth: options.rootWidth ?? 24,
      extensions: options.extensions ?? 2,
      cacheSize: Math.min(cacheSize, 1024),
      moveOrdering: optimized ? "previous" : "tactical",
      candidateCount: 5,
      dangerWork: 0,
    }).settings,
    cacheSize,
  };
  const profile = options.profile ?? "study";
  const ctx = createAiContext(
    position.state,
    settings,
    undefined,
    profile === "study"
      ? {
          evaluate: studyEvaluation,
          orderingBonus: rightCheckBonus,
          replaceCache: optimized,
          preservePromotions: optimized,
          measure: true,
          cacheLeafEvaluations: !optimized,
          allMoves: isDualStudyStrategy(options.strategy),
          measureDetails: options.measureDetails,
          sharedChecks: optimized && reuseChecks,
        }
      : optimized
        ? {
            evaluate: evaluateAiPosition,
            replaceCache: true,
            preservePromotions: true,
            measure: true,
            cacheLeafEvaluations: false,
            allMoves: isDualStudyStrategy(options.strategy),
            measureDetails: options.measureDetails,
            sharedChecks: reuseChecks,
          }
        : undefined,
  );
  const { stats, root } = ctx;
  const initialAssets = root ? assets(position.state, root) : 0;
  const rootEngagements = engagements(position.state);
  type Entry = {
    index: number;
    rightCheckPriority: boolean;
    move: OrdinaryMove;
    state: FourShogiState;
    branch: AiBranch;
    nodes: number;
    work: number;
    initialScore?: number;
  };
  const roots: Entry[] = [];
  let traceRootIndex = -1;
  let traceTaskDepth = 0;
  const diagnosticCacheNamespace = diagnostics?.includeAt
    ? JSON.stringify(diagnostics.includeAt)
    : "";
  function observingPath(path: readonly string[]) {
    return Boolean(
      diagnostics?.observe &&
      (!diagnostics.watchPaths ||
        diagnostics.watchPaths.some(
          (watch) => path.length <= watch.length && path.every((entry, i) => entry === watch[i]),
        )),
    );
  }
  function trace(event: StudyTraceEvent) {
    if (!diagnostics?.observe) return;
    const paths = diagnostics.watchPaths;
    if (
      paths &&
      !paths.some(
        (path) =>
          event.path.length <= path.length && event.path.every((entry, i) => entry === path[i]),
      )
    )
      return;
    diagnostics.observe(structuredClone(event));
  }
  const childPath = (path: readonly string[], step: AiLineStep) =>
    diagnostics ? [...path, studyTraceAction(step.side, step.action)] : path;
  const branchCache = new Map<string, AiBranch>();
  let branchCacheHits = 0;
  let keyMs = 0;
  let immediateWork = 0;
  let materialWork = 0;
  let preparationWork = 0;
  let rootSetupWork = 0;
  let reducedNodes = 0;
  let researches = 0;
  let promotionExtraMoves = 0;
  let checkingExtraMoves = 0;
  let checkingReserveNodes = 0;
  let quiescenceStops = 0;
  let quiescenceMoves = 0;
  let taskPolicy: StudyTaskPolicy | null = null;
  let taskPolicyKey = "";
  type Accounting = {
    foreignWork: number;
    foreignNodes: number;
    childWork: number;
    childNodes: number;
  };
  type Split = StudySplitPlan & { results: Map<number, StudySubtreeResult> | null };
  type Suspended = {
    split: Split;
    steps: Generator<number, void>;
    accounting: Accounting;
    work: number;
    nodes: number;
    rootIndex: number;
    targetDepth: number;
    policy: StudyTaskPolicy;
  };
  const suspended = new Map<number, Suspended>();
  // 同じ入力文脈の完全な差分状態だけを、応手担当の移動後にも再利用します。
  const subtreeStates = new Map<string, FourShogiState>();
  let subtreeStateCacheHits = 0;
  let subtreeStateKeyMs = 0;
  let nextPlanId = 0;
  let readySplit: Split | null = null;
  let partitionTask = false;
  let taskAccounting: Accounting | null = null;
  let completedSubtree: StudySubtreeResult | null = null;
  function resetSteps() {
    if (readySplit) throw new Error("未取得の分割計画があります");
    steps.return();
    completedSubtree = null;
    done = false;
    published = [];
  }
  const risks = new Map<number, NonNullable<AiCandidate["danger"]["alternatives"]>>();
  const materialProofs = new Map<
    number,
    Pick<StudyMaterialEvidence, "lossWitness" | "complete" | "limit">
  >();
  const immediate = new Map<number, { loss: readonly AiLineStep[] | null; complete: boolean }>();
  let published: Entry[] = [];
  let depth = 0;
  let done = false;
  let selected: Set<number> | null = null;
  let materialRootIndices: Set<number> | null = null;
  function make(entry: Entry): StudyCandidate {
    const candidate = makeAiCandidate(
      entry.move.action,
      entry.branch,
      root!,
      depth,
      entry.nodes,
      entry.work,
    );
    const first = candidate.line[0];
    const right = root ? studyRightSide(position.state, root) : null;
    const magic = Boolean(
      right &&
      first?.captured &&
      first.captured.side !== right &&
      first.checkedSides.includes(right),
    );
    const returnStep =
      candidate.danger.untilNextOwnTurn === "returned" ? candidate.danger.evidence.at(-1) : null;
    const lineDelta = root ? lineAssets(position.state, root, candidate.line) - initialAssets : 0;
    const confirmed = Boolean(
      magic &&
      first?.nextTurn === right &&
      returnStep &&
      returnStep.afterPly > 1 &&
      lineAssets(position.state, root!, candidate.danger.evidence) > initialAssets,
    );
    const magicEvidence: StudyCandidate["study"]["magicEvidence"] = magic
      ? {
          status: confirmed ? "line_confirmed" : "candidate",
          target: right!,
          returnedAtPly: confirmed ? returnStep!.afterPly : null,
        }
      : null;
    const proof = immediate.get(entry.index);
    const material = {
      initialAssets,
      lineDelta,
      ...(materialProofs.get(entry.index) ?? {
        lossWitness: null,
        complete: false,
        limit: "interrupted" as const,
      }),
    };
    return {
      ...candidate,
      selective: depth > 1 || candidate.selective,
      rootIndex: entry.index,
      danger: { ...candidate.danger, alternatives: risks.get(entry.index) ?? null },
      study: {
        ...(entry.initialScore === undefined ? {} : { initialScore: entry.initialScore }),
        immediateLoss: proof?.loss ?? null,
        immediateRepliesComplete: proof?.complete ?? false,
        rightSide: right,
        rightCheckPriority: entry.rightCheckPriority,
        magic,
        magicEvidence,
        material,
        engagements: rootEngagements,
        explanations: [
          ...(magic
            ? [
                confirmed
                  ? "この読み筋では右王への王手で先に自手番へ戻り、資産増加を保っています。全応手に対する成立証明ではありません。"
                  : "右王への王手を伴う第三者の駒取りの候補です。自手番への復帰と損得は未確認です。",
              ]
            : []),
          ...(proof?.loss ? ["次の相手手番で自分が脱落する合法手があります。"] : []),
          ...(material.lossWitness ? ["次の実自手番までに資産が減る合法な応手列があります。"] : []),
        ],
      },
    };
  }
  function* explore(
    state: FourShogiState,
    remaining: number,
    extra: number,
    ply: number,
    path: readonly string[] = [],
  ): Generator<number, AiBranch> {
    yield* ctx.spend(0);
    const observing = observingPath(path);
    const meta = diagnostics
      ? (): StudyTraceNode => ({
          rootIndex: traceRootIndex,
          taskDepth: traceTaskDepth,
          policy: taskPolicy,
          path,
          key: studyBranchKey(state, remaining, extra),
          remaining,
          extra,
          ply,
          turn: state.turn,
        })
      : undefined;
    const finish = observing
      ? (branch: AiBranch, reason: "terminal" | "horizon" | "cache" | "searched") => {
          if (observing)
            trace({
              ...meta!(),
              type: "return",
              reason,
              evaluation: branch.evaluation,
              line: branch.line,
            });
          return branch;
        }
      : keepBranch;
    if (state.status === "finished" || !getActiveSides(state).includes(root!))
      return finish(
        { evaluation: yield* ctx.evaluate(state), line: [], selective: false },
        "terminal",
      );
    const checks = ctx.checks(state);
    const checked = checks[state.turn];
    const useQuiescence = selectiveQuiescence && taskPolicy?.phase === "deep";
    const quietReason =
      useQuiescence && remaining <= 0 && extra > 0 ? studyQuiescenceReason(state, checks) : null;
    let extensionReason:
      | Parameters<NonNullable<StudySearchDiagnostics["profileExtension"]>>[0]["reason"]
      | null = null;
    let tacticalOnly = false;
    if (
      remaining <= 0 &&
      extra > 0 &&
      (useQuiescence
        ? quietReason !== null
        : checked ||
          state.lastMove?.captured ||
          state.turn === root ||
          (optimized &&
            state.lastMove?.action.type === "movePiece" &&
            state.lastMove.action.promote))
    ) {
      extensionReason = useQuiescence
        ? quietReason
        : checked
          ? "check"
          : state.lastMove?.captured
            ? "capture"
            : state.lastMove?.action.type === "movePiece" && state.lastMove.action.promote
              ? "promotion"
              : "own_turn";
      tacticalOnly = useQuiescence ? !checked : optimized && !checked && state.turn !== root;
      remaining = 1;
      extra--;
      stats.extendedNodes++;
    }
    if (useQuiescence && remaining <= 0 && extra > 0) quiescenceStops++;
    if (remaining <= 0)
      return finish(
        { evaluation: yield* ctx.evaluate(state), line: [], selective: useQuiescence && checked },
        "horizon",
      );
    const started = performance.now();
    // 完全状態を使います。攻撃/反復履歴やlastMoveを省略した同一視は行いません。
    const key =
      optimized && remaining > 1 && settings.cacheSize > 0 && !diagnostics?.disableBranchCache
        ? taskPolicyKey + diagnosticCacheNamespace + studyBranchKey(state, remaining, extra)
        : null;
    keyMs += performance.now() - started;
    const cached = key === null ? undefined : branchCache.get(key);
    if (cached) {
      branchCacheHits++;
      return finish(
        {
          ...cached,
          line: cached.line.map((step) => ({ ...step, afterPly: step.afterPly + ply })),
        },
        "cache",
      );
    }
    const rankingStartWork = stats.work;
    const legal = yield* ctx.moves(state);
    let moves = yield* ctx.ordered(state, legal);
    const orderedBefore = moves;
    let afterBroad = moves;
    if (isDualStudyStrategy(options.strategy) && taskPolicy?.phase !== "deep") {
      moves = moves.filter(
        (entry, order) =>
          order < settings.width ||
          checked ||
          entry.score >= 10000 ||
          entry.move.captured ||
          (entry.move.action.type === "movePiece" && entry.move.action.promote),
      );
    }
    afterBroad = moves;
    if (useQuiescence && extensionReason) {
      moves = selectStudyQuiescenceMoves(moves, state, checked);
      quiescenceMoves += moves.length;
    } else if (tacticalOnly) {
      // 仮のパスは作らず、実際の静かな合法手も最低一つ残します。
      let quiet = false;
      moves = moves.filter((entry) => {
        if (
          entry.score >= 10000 ||
          entry.move.captured ||
          (entry.move.action.type === "movePiece" && entry.move.action.promote)
        )
          return true;
        if (quiet) return false;
        quiet = true;
        return true;
      });
    }
    let best: AiBranch | null = null;
    let bestIndex = Infinity;
    let bestMove: OrdinaryMove | null = null;
    let selective = moves.length < legal.length;
    if (taskPolicy?.phase === "deep") {
      const ranked: {
        move: OrdinaryMove;
        index: number;
        next: AiAdvance;
        evaluation: AiEvaluation;
      }[] = [];
      // 全合法応手を一手は確定して評価し、仮のパスや未確定盤面の値を使いません。
      for (const { move, index } of moves) {
        const next = yield* ctx.advance(state, move, ply);
        ranked.push({ move, index, next, evaluation: yield* ctx.evaluate(next.state) });
      }
      ranked.sort(
        (a, b) =>
          compareAiValue(b.evaluation.values[state.turn], a.evaluation.values[state.turn]) ||
          a.index - b.index,
      );
      const width = state.turn === root ? taskPolicy.ownWidth : taskPolicy.width;
      const selected =
        remaining === 1 ? [...ranked] : ranked.slice(0, Math.max(checked ? 4 : 1, width));
      // 自手番の成り継続を静的評価だけで落とさず、追加は各節点で一手に制限します。
      const promotion =
        preserveOwnPromotion && remaining > 1 && state.turn === root
          ? ranked.find(
              (entry) =>
                entry.move.action.type === "movePiece" &&
                entry.move.action.promote &&
                !selected.includes(entry),
            )
          : undefined;
      if (promotion) {
        selected.push(promotion);
        promotionExtraMoves++;
      }
      const checking = (() => {
        if (!preserveCheckingDiversity || remaining <= 1 || state.turn !== root) return undefined;
        if (options.measureDetails) checkingReserveNodes++;
        const rays = (entry: (typeof ranked)[number]) =>
          entry.next.step.checkedSides.length
            ? studyCheckingRays(entry.next.state, state.turn!)
            : [];
        const covered = new Set(selected.flatMap(rays));
        return ranked.find(
          (entry) => !selected.includes(entry) && rays(entry).some((ray) => !covered.has(ray)),
        );
      })();
      if (checking) {
        selected.push(checking);
        checkingExtraMoves++;
      }
      const include = diagnostics?.includeAt;
      const intervention =
        include &&
        include.key === studyBranchKey(state, remaining, extra) &&
        JSON.stringify(include.path) === JSON.stringify(path)
          ? legal.findIndex(
              (move) => JSON.stringify(move.action) === JSON.stringify(include.action),
            )
          : -1;
      if (intervention >= 0 && !selected.some((entry) => entry.index === intervention)) {
        let entry = ranked.find((candidate) => candidate.index === intervention);
        if (!entry) {
          const move = legal[intervention];
          const next = yield* ctx.advance(state, move, ply);
          entry = { move, index: intervention, next, evaluation: yield* ctx.evaluate(next.state) };
        }
        selected.push(entry);
      }
      if (extensionReason)
        diagnostics?.profileExtension?.(
          Object.freeze({
            reason: extensionReason,
            ply,
            turn: state.turn,
            extra,
            legalMoves: legal.length,
            rankedMoves: ranked.length,
            selectedMoves: selected.length,
            rankingWork: stats.work - rankingStartWork,
          }),
        );
      if (observing) {
        const rows: StudySelectionRow[] = legal.map((move, index) => {
          const orderedIndex = orderedBefore.findIndex((entry) => entry.index === index);
          const staticIndex = ranked.findIndex((entry) => entry.index === index);
          const chosen = selected.some((entry) => entry.index === index);
          return {
            index,
            action: move.action,
            orderRank: orderedIndex < 0 ? null : orderedIndex + 1,
            orderScore: orderedBefore[orderedIndex]?.score ?? null,
            staticRank: staticIndex < 0 ? null : staticIndex + 1,
            evaluation: ranked[staticIndex]?.evaluation ?? null,
            selected: chosen,
            reason: chosen
              ? index === intervention
                ? "diagnostic_include"
                : index === promotion?.index
                  ? "promotion_reserve"
                  : index === checking?.index
                    ? "checking_reserve"
                    : "selected"
              : orderedIndex < 0
                ? "ordering_filter"
                : !afterBroad.some((entry) => entry.index === index)
                  ? "broad_filter"
                  : !moves.some((entry) => entry.index === index)
                    ? "extension_filter"
                    : "top_k",
          };
        });
        trace({
          ...meta!(),
          type: "selection",
          state: { ...state, repetitions: { ...position.state.repetitions, ...state.repetitions } },
          rows,
          checked,
          tacticalOnly,
        });
      }
      selective ||= selected.length < ranked.length;
      // 順序依存のLMR・延長を分割せず、深いMaxNの根直下だけを独立に評価します。
      // 追加候補も含む同じselectedを維持し、過大な分割は元の逐次探索へ戻します。
      const independent =
        partitionTask && ply === 1 && remaining >= 3
          ? selected.filter((entry) => entry.next.state.status !== "finished")
          : null;
      let split: Split | null = null;
      if (
        partitionTask &&
        ply === 1 &&
        remaining >= 3 &&
        (options.strategy === "dual" || options.strategy === "dual-continuations") &&
        independent !== null &&
        independent.length >= 2 &&
        independent.length <= 16 &&
        suspended.size < 8
      ) {
        split = {
          planId: ++nextPlanId,
          tasks: independent.map((entry) => ({
            slot: entry.index,
            baseStateHash: position.stateHash,
            rootIndex: traceRootIndex,
            targetDepth: traceTaskDepth,
            policy: { ...taskPolicy! },
            state: entry.next.state,
            remaining: remaining - 1,
            extra,
            ply: ply + 1,
          })),
          results: null,
        };
        readySplit = split;
        yield 0;
        if (!split.results) throw new Error("未完成の子タスクを集約できません");
      }
      for (const entry of selected) {
        const child =
          (remaining === 1 && (!extendDeepLeaves || (selectiveQuiescence && extra === 0))) ||
          entry.next.state.status === "finished"
            ? { evaluation: entry.evaluation, line: [], selective: false }
            : split
              ? split.results!.get(entry.index)!.branch
              : yield* explore(
                  entry.next.state,
                  remaining - 1,
                  extra,
                  ply + 1,
                  childPath(path, entry.next.step),
                );
        if (observing)
          trace({
            ...meta!(),
            type: "child",
            action: entry.move.action,
            evaluation: child.evaluation,
          });
        selective ||= child.selective;
        const comparison = best
          ? compareAiValue(child.evaluation.values[state.turn], best.evaluation.values[state.turn])
          : 1;
        if (comparison > 0 || (comparison === 0 && entry.index < bestIndex)) {
          best = { ...child, line: [entry.next.step, ...child.line] };
          bestIndex = entry.index;
          bestMove = entry.move;
        }
      }
    } else {
      const include = diagnostics?.includeAt;
      const intervention =
        include &&
        include.key === studyBranchKey(state, remaining, extra) &&
        JSON.stringify(include.path) === JSON.stringify(path)
          ? legal.findIndex(
              (move) => JSON.stringify(move.action) === JSON.stringify(include.action),
            )
          : -1;
      if (intervention >= 0 && !moves.some((entry) => entry.index === intervention)) {
        const move = legal[intervention];
        moves = [
          ...moves,
          orderedBefore.find((entry) => entry.index === intervention) ?? {
            move,
            index: intervention,
            score:
              priority(move, state.turn) + (profile === "study" ? rightCheckBonus(state, move) : 0),
          },
        ];
      }
      if (observing)
        trace({
          ...meta!(),
          type: "selection",
          state: { ...state, repetitions: { ...position.state.repetitions, ...state.repetitions } },
          checked,
          tacticalOnly,
          rows: legal.map((move, index) => {
            const order = orderedBefore.findIndex((entry) => entry.index === index);
            const selected = moves.some((entry) => entry.index === index);
            return {
              index,
              action: move.action,
              orderRank: order < 0 ? null : order + 1,
              orderScore: orderedBefore[order]?.score ?? null,
              staticRank: null,
              evaluation: null,
              selected,
              reason: selected
                ? index === intervention
                  ? "diagnostic_include"
                  : "selected"
                : order < 0
                  ? "ordering_filter"
                  : !afterBroad.some((entry) => entry.index === index)
                    ? "broad_filter"
                    : "extension_filter",
            };
          }),
        });
      for (const [order, { move, index, score }] of moves.entries()) {
        const next = yield* ctx.advance(state, move, ply);
        const reduce =
          optimized &&
          remaining >= 3 &&
          order >= 2 &&
          !checked &&
          score < 10000 &&
          !move.captured &&
          !(move.action.type === "movePiece" && move.action.promote);
        let child = yield* explore(
          next.state,
          remaining - 1 - Number(reduce),
          extra,
          ply + 1,
          childPath(path, next.step),
        );
        if (reduce) {
          reducedNodes++;
          selective = true;
          if (
            !best ||
            compareAiValue(
              child.evaluation.values[state.turn],
              best.evaluation.values[state.turn],
            ) >= 0
          ) {
            researches++;
            child = yield* explore(
              next.state,
              remaining - 1,
              extra,
              ply + 1,
              childPath(path, next.step),
            );
          }
        }
        if (observing)
          trace({
            ...meta!(),
            type: "child",
            action: move.action,
            evaluation: child.evaluation,
          });
        selective ||= child.selective;
        const comparison = best
          ? compareAiValue(child.evaluation.values[state.turn], best.evaluation.values[state.turn])
          : 1;
        if (comparison > 0 || (comparison === 0 && index < bestIndex)) {
          best = {
            ...child,
            line: [next.step, ...child.line],
            selective: moves.length < legal.length || child.selective,
          };
          bestIndex = index;
          bestMove = move;
        }
      }
    }
    if (optimized && bestMove) ctx.remember(state, bestMove.action);
    const result = best
      ? { ...best, selective }
      : { evaluation: yield* ctx.evaluate(state), line: [], selective: false };
    if (key !== null) {
      if (branchCache.size >= settings.cacheSize)
        branchCache.delete(branchCache.keys().next().value!);
      branchCache.set(key, {
        ...result,
        line: result.line.map((step) => ({ ...step, afterPly: step.afterPly - ply })),
      });
    }
    return finish(result, "searched");
  }
  function* inspectImmediate(entry: Entry): Generator<number, void> {
    const started = stats.work;
    const proof = { loss: null as readonly AiLineStep[] | null, complete: false };
    immediate.set(entry.index, proof);
    let exhausted = true;
    if (!getActiveSides(entry.state).includes(root!)) proof.loss = entry.branch.line;
    else if (entry.state.status === "playing" && entry.state.turn !== root) {
      const responses = yield* ctx.moves(entry.state);
      for (const move of responses) {
        const next = yield* ctx.advance(entry.state, move, 1);
        if (!getActiveSides(next.state).includes(root!)) {
          proof.loss = [entry.branch.line[0], next.step];
          exhausted = false;
          break;
        }
      }
    }
    proof.complete = exhausted;
    immediateWork += stats.work - started;
  }
  function* inspectMaterial(entry: Entry): Generator<number, void> {
    const started = stats.work;
    const probe = probeMaterialReplies(
      ctx,
      entry.state,
      entry.branch.line[0],
      options.dangerWork ?? 128,
      initialAssets,
    );
    risks.set(entry.index, probe.result);
    materialProofs.set(entry.index, probe.material);
    yield* probe.steps;
    materialWork += stats.work - started;
  }
  function* run(): Generator<number, void> {
    if (position.state.status === "finished" || !ctx.legal.length) return;
    // 元の番号でレーンを固定したまま、各レーン内では右への新規王手を先に調べます。
    const orderedRoots = ctx.legal
      .map((move, index) => ({
        move,
        index,
        rightCheckPriority:
          profile === "study" && rightCheckBonus(position.state, move, ctx.checks) > 0,
      }))
      .sort(
        (a, b) => Number(b.rightCheckPriority) - Number(a.rightCheckPriority) || a.index - b.index,
      );
    for (const { index, move, rightCheckPriority } of orderedRoots) {
      if (index % lanes !== lane) continue;
      const before = { ...stats };
      const next = yield* ctx.advance(ctx.start, move, 0);
      const evaluation = yield* ctx.evaluate(next.state);
      preparationWork += stats.work - before.work;
      roots.push({
        index,
        rightCheckPriority,
        move,
        state: next.state,
        branch: { evaluation, line: [next.step], selective: false },
        nodes: stats.nodes - before.nodes,
        work: stats.work - before.work,
        ...(optimized ? { initialScore: evaluation.values[root!].heuristicScore ?? 0 } : {}),
      });
    }
    published = roots;
    depth = stats.completedDepth = 1;
    // この境界で全プロセスに共通する根候補集合を受け取ります。
    yield* ctx.spend(0);
    const active = roots.filter((entry) => selected === null || selected.has(entry.index));
    // 浅い全体評価の先頭5件を固定し、後の反復で順位が変わっても検査範囲を偽りません。
    const materialIndices =
      profile !== "study"
        ? new Set<number>()
        : (materialRootIndices ??
          new Set(
            lanes === 1
              ? selectStudyRootIndices(roots.map(make), root!, settings.rootWidth).slice(0, 5)
              : [],
          ));
    if (profile === "study") for (const entry of active) yield* inspectImmediate(entry);
    for (let nextDepth = 2; nextDepth <= settings.maxDepth; nextDepth++) {
      const completed: Entry[] = [];
      for (const entry of active) {
        const before = { ...stats };
        traceRootIndex = entry.index;
        traceTaskDepth = nextDepth;
        const branch = yield* explore(
          entry.state,
          nextDepth - 1,
          settings.extensions,
          1,
          diagnostics ? [studyTraceAction(root!, entry.move.action)] : [],
        );
        completed.push({
          ...entry,
          branch: { ...branch, line: [entry.branch.line[0], ...branch.line] },
          nodes: stats.nodes - before.nodes,
          work: stats.work - before.work,
        });
      }
      published = completed;
      depth = stats.completedDepth = nextDepth;
      yield* ctx.spend(0);
      // 深さ2の完成結果を全レーンで公開してから、表示用の詳細検査へ残り予算を使います。
      if (profile === "study" && nextDepth === 2)
        for (const entry of completed)
          if (materialIndices.has(entry.index)) yield* inspectMaterial(entry);
    }
  }
  let steps = run();
  return {
    get work() {
      return stats.work;
    },
    get depth() {
      return depth;
    },
    step() {
      if (done) return true;
      const next = steps.next();
      done = next.done ?? false;
      return done;
    },
    setRootIndices(indices: readonly number[]) {
      selected = new Set(indices);
      materialRootIndices = new Set(indices.slice(0, 5));
    },
    /** 根一手を任意のプロセスで調べ、共通深さの公開は親に委ねます。 */
    startTask(
      index: number,
      targetDepth: number,
      inspectMaterialProof = false,
      policy?: StudyTaskPolicy,
      partition = false,
    ) {
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= ctx.legal.length ||
        !Number.isSafeInteger(targetDepth) ||
        targetDepth < 2 ||
        targetDepth > settings.maxDepth
      )
        throw new TypeError("探索タスクの根または深さが不正です");
      resetSteps();
      if (
        policy &&
        (!Number.isSafeInteger(policy.width) ||
          policy.width < 1 ||
          policy.width > 32 ||
          !Number.isSafeInteger(policy.ownWidth) ||
          policy.ownWidth < 1 ||
          policy.ownWidth > 32)
      )
        throw new TypeError("段階拡張の幅が不正です");
      traceRootIndex = index;
      traceTaskDepth = targetDepth;
      taskPolicy = policy ?? null;
      taskPolicyKey = policy ? JSON.stringify(policy) : "";
      partitionTask = partition && policy?.phase === "deep" && !diagnostics;
      const accounting: Accounting = {
        foreignWork: 0,
        foreignNodes: 0,
        childWork: 0,
        childNodes: 0,
      };
      taskAccounting = accounting;
      depth = targetDepth - 1;
      steps = (function* (): Generator<number, void> {
        let entry = roots.find((entry) => entry.index === index);
        if (!entry) {
          const setupWork = stats.work;
          const move = ctx.legal[index];
          const next = yield* ctx.advance(ctx.start, move, 0);
          const evaluation = yield* ctx.evaluate(next.state);
          entry = {
            index,
            move,
            state: next.state,
            rightCheckPriority:
              profile === "study" && rightCheckBonus(position.state, move, ctx.checks) > 0,
            branch: { evaluation, line: [next.step], selective: false },
            nodes: 0,
            work: 0,
            ...(optimized ? { initialScore: evaluation.values[root!].heuristicScore ?? 0 } : {}),
          };
          roots.push(entry);
          rootSetupWork += stats.work - setupWork;
        }
        if (profile === "study" && !immediate.has(index)) yield* inspectImmediate(entry);
        const before = { ...stats };
        const branch = yield* explore(
          entry.state,
          targetDepth - 1,
          settings.extensions,
          1,
          diagnostics ? [studyTraceAction(root!, entry.move.action)] : [],
        );
        const completed = {
          ...entry,
          branch: { ...branch, line: [entry.branch.line[0], ...branch.line] },
          nodes: stats.nodes - before.nodes - accounting.foreignNodes + accounting.childNodes,
          work: stats.work - before.work - accounting.foreignWork + accounting.childWork,
        };
        if (inspectMaterialProof && profile === "study" && !materialProofs.has(index))
          yield* inspectMaterial(completed);
        published = [completed];
        depth = stats.completedDepth = targetDepth;
      })();
    },
    /** 計画を取得した時点で生成器を退避し、同じ文脈を別の独立タスクへ使えます。 */
    takeSplitPlan(): StudySplitPlan | null {
      if (!readySplit) return null;
      const split = readySplit;
      readySplit = null;
      suspended.set(split.planId, {
        split,
        steps,
        accounting: taskAccounting!,
        work: stats.work,
        nodes: stats.nodes,
        rootIndex: traceRootIndex,
        targetDepth: traceTaskDepth,
        policy: { ...taskPolicy! },
      });
      steps = (function* (): Generator<number, void> {})();
      done = true;
      return { planId: split.planId, tasks: split.tasks };
    },
    startSubtree(task: StudySubtreeTask | { localPlanId: number; slot: number }) {
      const input =
        "localPlanId" in task
          ? suspended.get(task.localPlanId)?.split.tasks.find((entry) => entry.slot === task.slot)
          : task;
      if (
        !input ||
        input.baseStateHash !== position.stateHash ||
        !Number.isSafeInteger(input.rootIndex) ||
        input.rootIndex < 0 ||
        input.rootIndex >= ctx.legal.length ||
        !Number.isSafeInteger(input.targetDepth) ||
        input.targetDepth < 4 ||
        input.targetDepth > settings.maxDepth ||
        !Number.isSafeInteger(input.remaining) ||
        input.remaining < 1 ||
        input.ply !== 2 ||
        input.remaining !== input.targetDepth - input.ply ||
        input.extra !== settings.extensions ||
        input.policy.phase !== "deep" ||
        !Number.isSafeInteger(input.slot) ||
        input.slot < 0 ||
        !Number.isSafeInteger(input.policy.width) ||
        input.policy.width < 1 ||
        input.policy.width > 32 ||
        !Number.isSafeInteger(input.policy.ownWidth) ||
        input.policy.ownWidth < 1 ||
        input.policy.ownWidth > 32 ||
        (options.strategy !== "dual" && options.strategy !== "dual-continuations")
      )
        throw new TypeError("独立探索タスクの文脈が不正です");
      resetSteps();
      if (options.subtreeCacheLimit !== undefined) ctx.limitCache(options.subtreeCacheLimit);
      let subtreeState = input.state;
      if (!("localPlanId" in task) && settings.cacheSize > 0) {
        const started = options.measureDetails ? performance.now() : 0;
        const key = JSON.stringify(input.state);
        if (options.measureDetails) subtreeStateKeyMs += performance.now() - started;
        const cached = subtreeStates.get(key);
        if (cached) {
          subtreeState = cached;
          subtreeStateCacheHits++;
        } else {
          if (subtreeStates.size >= Math.min(64, settings.cacheSize))
            subtreeStates.delete(subtreeStates.keys().next().value!);
          subtreeStates.set(key, subtreeState);
        }
      }
      traceRootIndex = input.rootIndex;
      traceTaskDepth = input.targetDepth;
      taskPolicy = input.policy;
      taskPolicyKey = JSON.stringify(taskPolicy);
      partitionTask = false;
      taskAccounting = null;
      depth = input.targetDepth - 1;
      steps = (function* (): Generator<number, void> {
        const before = { work: stats.work, nodes: stats.nodes };
        const branch = yield* explore(subtreeState, input.remaining, input.extra, input.ply);
        completedSubtree = {
          slot: input.slot,
          branch,
          work: stats.work - before.work,
          nodes: stats.nodes - before.nodes,
        };
      })();
    },
    subtreeResult(): StudySubtreeResult | null {
      return completedSubtree;
    },
    finishSplitPlan(planId: number, results: readonly StudySubtreeResult[]) {
      const pending = suspended.get(planId);
      if (
        !pending ||
        results.length !== pending.split.tasks.length ||
        new Set(results.map((r) => r.slot)).size !== results.length ||
        results.some(
          (r) =>
            !pending.split.tasks.some((t) => t.slot === r.slot) ||
            !Number.isSafeInteger(r.work) ||
            r.work < 0 ||
            !Number.isSafeInteger(r.nodes) ||
            r.nodes < 0,
        )
      )
        throw new TypeError("分割探索の結果が不足または重複しています");
      resetSteps();
      suspended.delete(planId);
      pending.split.results = new Map(results.map((r) => [r.slot, r]));
      pending.accounting.foreignWork += stats.work - pending.work;
      pending.accounting.foreignNodes += stats.nodes - pending.nodes;
      pending.accounting.childWork += results.reduce((n, r) => n + r.work, 0);
      pending.accounting.childNodes += results.reduce((n, r) => n + r.nodes, 0);
      taskAccounting = pending.accounting;
      traceRootIndex = pending.rootIndex;
      traceTaskDepth = pending.targetDepth;
      taskPolicy = pending.policy;
      taskPolicyKey = JSON.stringify(taskPolicy);
      partitionTask = false;
      depth = pending.targetDepth - 1;
      steps = pending.steps;
    },
    snapshot(): StudyLaneSnapshot {
      return {
        lane,
        depth,
        done,
        candidates: published.map(make),
        staticEvaluation: ctx.staticEvaluation,
        stats: { ...stats },
        performance: {
          ...ctx.metrics,
          branchCacheHits,
          branchCacheEntries: branchCache.size,
          keyMs,
          immediateWork,
          materialWork,
          preparationWork,
          rootSetupWork,
          contextCacheEntries: stats.cacheEntries,
          contextCacheCapacity: ctx.cacheLimit,
          reducedNodes,
          researches,
          promotionExtraMoves,
          checkingExtraMoves,
          checkingReserveNodes,
          extendedNodes: stats.extendedNodes,
          quiescenceStops,
          quiescenceMoves,
          subtreeStateCacheHits,
          subtreeStateCacheEntries: subtreeStates.size,
          subtreeStateKeyMs,
        },
      };
    },
    dispose() {
      steps.return();
      for (const pending of suspended.values()) pending.steps.return();
      suspended.clear();
      subtreeStates.clear();
      readySplit = null;
      completedSubtree = null;
      done = true;
    },
  };
}
