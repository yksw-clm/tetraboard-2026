import { getCheckState } from "./board";
import { priority } from "./cpuSearch";
import { compareAiValue, evaluateAiPosition } from "./aiEvaluation";
import { applyLegalMove, getLegalMoves } from "./transition";
import { getActiveSides, type FourShogiState, type Side } from "./types";
import type { OrdinaryMove } from "./moves";
import type {
  AiCandidate,
  AiEvaluation,
  AiLineStep,
  AiSearchSettings,
  AiStopReason,
} from "./aiTypes";

type Branch = { evaluation: AiEvaluation; line: AiLineStep[]; selective: boolean };
type RootCandidate = {
  move: OrdinaryMove;
  state: FourShogiState;
  branch: Branch;
  index: number;
  nodes: number;
  work: number;
};
export function checkedSides(state: FourShogiState): Side[] {
  const checks = getCheckState(state);
  return getActiveSides(state).filter((side) => checks[side]);
}
function danger(line: readonly AiLineStep[], root: Side): AiCandidate["danger"] {
  let boundary: AiCandidate["danger"]["untilNextOwnTurn"] = "horizon";
  let end = line.length;
  for (const [index, step] of line.entries()) {
    if (step.eliminations.some((entry) => entry.side === root)) boundary = "eliminated";
    else if (step.result) boundary = "terminal";
    else if (step.nextTurn === root) boundary = "returned";
    if (boundary !== "horizon") {
      end = index + 1;
      break;
    }
  }
  return {
    kind: "pv_example",
    forced: false,
    untilNextOwnTurn: boundary,
    evidence: line.slice(0, end),
  };
}

/** 数える操作の直前にyieldし、運転側が期限・取消・処理量を検査します。 */
export function createAiSearch(input: FourShogiState, settings: AiSearchSettings) {
  if (input.mode !== "singles") throw new TypeError("新AIはシングルス専用です");
  const stats = {
    work: 0,
    nodes: 0,
    generatedMoves: 0,
    evaluations: 0,
    completedDepth: 0,
    extendedNodes: 0,
  };
  const root = input.turn;
  const start: FourShogiState = { ...input, repetitions: {} };
  const lookup = (key: string) => input.repetitions[key] ?? 0;
  // 取消済みでも合法な予備着手を確保します。このルール呼出し自体は分割しません。
  const legal = getLegalMoves(start);
  stats.generatedMoves = legal.length;
  const includeIndex =
    settings.includeAction === null
      ? -1
      : legal.findIndex(
          (move) => JSON.stringify(move.action) === JSON.stringify(settings.includeAction),
        );
  if (settings.includeAction !== null && includeIndex < 0)
    throw new TypeError("比較指定手は元局面の合法手である必要があります");
  let published: AiCandidate[] = [];
  let comparedAction: AiCandidate | null = null;
  let doneReason: AiStopReason =
    input.status === "finished"
      ? "terminal"
      : legal.length === 0
        ? "no_legal_actions"
        : "max_depth";

  function* spend(cost = 1): Generator<number, void> {
    yield cost;
    stats.work += cost;
  }
  function* evaluate(state: FourShogiState): Generator<number, AiEvaluation> {
    yield* spend();
    stats.evaluations++;
    return evaluateAiPosition(state);
  }
  function* advance(
    state: FourShogiState,
    move: OrdinaryMove,
    ply: number,
  ): Generator<number, { state: FourShogiState; step: AiLineStep }> {
    yield* spend();
    stats.nodes++;
    const transition = applyLegalMove(state, state.turn!, move, lookup);
    const next = transition.state;
    return {
      state: next,
      step: {
        side: state.turn!,
        action: move.action,
        afterPly: ply + 1,
        nextTurn: next.turn,
        checkedSides: checkedSides(next),
        captured: transition.captured,
        eliminations: transition.eliminations,
        result: next.result,
      },
    };
  }
  function* explore(
    state: FourShogiState,
    depth: number,
    extra: number,
    ply: number,
  ): Generator<number, Branch> {
    yield* spend(0);
    if (state.status === "finished")
      return { evaluation: yield* evaluate(state), line: [], selective: false };
    const checked = getCheckState(state)[state.turn];
    if (depth <= 0 && extra > 0 && (checked || state.lastMove?.captured || state.turn === root)) {
      depth = 1;
      extra--;
      stats.extendedNodes++;
    }
    if (depth <= 0) return { evaluation: yield* evaluate(state), line: [], selective: false };
    yield* spend();
    const legalMoves = getLegalMoves(state);
    stats.generatedMoves += legalMoves.length;
    yield* spend(Math.ceil(legalMoves.length / 16));
    const ordered = legalMoves
      .map((move, index) => ({ move, index, score: priority(move, state.turn) }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .filter(
        (entry, index) =>
          index < settings.width ||
          checked ||
          entry.score >= 10_000 ||
          entry.move.captured !== null,
      );
    let best: Branch | null = null;
    let bestIndex = Infinity;
    let selective = ordered.length < legalMoves.length;
    // 二人生存も実手番者の値で選び、相手の値を根の負値へ読み替えません。
    for (const { move, index } of ordered) {
      const next = yield* advance(state, move, ply);
      const child = yield* explore(next.state, depth - 1, extra, ply + 1);
      selective ||= child.selective;
      const branch = {
        evaluation: child.evaluation,
        line: [next.step, ...child.line],
        selective: child.selective || ordered.length < legalMoves.length,
      };
      const comparison =
        best === null
          ? 1
          : compareAiValue(
              branch.evaluation.values[state.turn],
              best.evaluation.values[state.turn],
            );
      if (comparison > 0 || (comparison === 0 && index < bestIndex)) {
        best = branch;
        bestIndex = index;
      }
    }
    return best === null
      ? { evaluation: yield* evaluate(state), line: [], selective }
      : { ...best, selective };
  }
  const compareRoot = (a: RootCandidate, b: RootCandidate) =>
    compareAiValue(b.branch.evaluation.values[root!], a.branch.evaluation.values[root!]) ||
    a.index - b.index;
  function publish(candidates: RootCandidate[], depth: number, rootPruned: boolean) {
    const result = candidates.sort(compareRoot).map((candidate): AiCandidate => ({
      action: candidate.move.action,
      evaluation: candidate.branch.evaluation,
      completedDepth: depth,
      iterationNodes: candidate.nodes,
      iterationWork: candidate.work,
      selective: rootPruned || candidate.branch.selective,
      cutoff: false,
      line: candidate.branch.line,
      danger: danger(candidate.branch.line, root!),
    }));
    published = result.slice(0, settings.candidateCount);
    comparedAction =
      includeIndex < 0
        ? null
        : result.find(
            (candidate) =>
              JSON.stringify(candidate.action) === JSON.stringify(settings.includeAction),
          )!;
    stats.completedDepth = depth;
  }
  function* run(): Generator<number, void> {
    if (input.status === "finished" || legal.length === 0) return;
    yield* spend(1 + Math.ceil(legal.length / 16));
    const shallow: RootCandidate[] = [];
    for (const [index, move] of legal.entries()) {
      const before = { ...stats };
      const next = yield* advance(start, move, 0);
      const evaluation = yield* evaluate(next.state);
      shallow.push({
        move,
        index,
        state: next.state,
        branch: { evaluation, line: [next.step], selective: false },
        nodes: stats.nodes - before.nodes,
        work: stats.work - before.work,
      });
    }
    publish(shallow, 1, false);
    yield* spend(0);
    if (
      published[0].evaluation!.evaluationKind === "terminal" &&
      published[0].evaluation!.values[root!].primary === 1
    ) {
      doneReason = "sole_win";
      return;
    }
    const selected = shallow.filter(
      (candidate, index) =>
        index < settings.rootWidth ||
        candidate.index === includeIndex ||
        candidate.state.lastMove?.captured ||
        (candidate.state.status === "playing" &&
          getCheckState(candidate.state)[candidate.state.turn]),
    );
    for (let depth = 2; depth <= settings.maxDepth; depth++) {
      const completed: RootCandidate[] = [];
      for (const candidate of selected) {
        const before = { ...stats };
        const child = yield* explore(candidate.state, depth - 1, settings.extensions, 1);
        completed.push({
          ...candidate,
          branch: { ...child, line: [candidate.branch.line[0], ...child.line] },
          nodes: stats.nodes - before.nodes,
          work: stats.work - before.work,
        });
      }
      publish(completed, depth, selected.length < legal.length);
      yield* spend(0);
    }
  }
  function results(cutoff = false) {
    if (published.length === 0 && legal.length > 0 && root !== null) {
      const fallback: AiCandidate = {
        action: legal[0].action,
        evaluation: null,
        completedDepth: 0,
        iterationNodes: 0,
        iterationWork: 0,
        selective: true,
        cutoff,
        line: [],
        danger: danger([], root),
      };
      return { candidates: [fallback], comparedAction: null };
    }
    return {
      candidates: published.map((candidate) => ({ ...candidate, cutoff })),
      comparedAction: comparedAction === null ? null : { ...comparedAction, cutoff },
    };
  }
  return {
    steps: run(),
    stats,
    results,
    get doneReason() {
      return doneReason;
    },
  };
}
