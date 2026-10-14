import { getCheckState } from "./board";
import { compareAiValue } from "./aiEvaluation";
import { createAiContext, makeAiCandidate, type AiBranch, type AiContext } from "./aiSearchContext";
import { probeAiReplies } from "./aiTactics";
import type { OrdinaryMove } from "./moves";
import { getActiveSides, type FourShogiState } from "./types";
import type { AiCandidate, AiSearchSettings, AiStopReason } from "./aiTypes";
export { checkedSides } from "./aiSearchContext";

type RootCandidate = {
  move: OrdinaryMove;
  state: FourShogiState;
  branch: AiBranch;
  index: number;
  nodes: number;
  work: number;
};
export function createAiSearch(
  input: FourShogiState,
  settings: AiSearchSettings,
  context?: AiContext,
) {
  const ctx = context ?? createAiContext(input, settings);
  const { stats, root, start, legal, spend, evaluate, advance } = ctx;
  let published: AiCandidate[] = [];
  let comparedAction: AiCandidate | null = null;
  const risks = new Map<number, NonNullable<AiCandidate["danger"]["alternatives"]>>();
  let doneReason: AiStopReason =
    input.status === "finished"
      ? "terminal"
      : legal.length === 0
        ? "no_legal_actions"
        : "max_depth";
  function* explore(
    state: FourShogiState,
    depth: number,
    extra: number,
    ply: number,
  ): Generator<number, AiBranch> {
    yield* spend(0);
    if (state.status === "finished" || !getActiveSides(state).includes(root!))
      return { evaluation: yield* evaluate(state), line: [], selective: false };
    const checked = getCheckState(state)[state.turn];
    if (depth <= 0 && extra > 0 && (checked || state.lastMove?.captured || state.turn === root)) {
      depth = 1;
      extra--;
      stats.extendedNodes++;
    }
    if (depth <= 0) return { evaluation: yield* evaluate(state), line: [], selective: false };
    const moves = yield* ctx.moves(state);
    const ordered = ctx.ordered(state, moves);
    let best: AiBranch | null = null;
    let bestIndex = Infinity;
    let bestMove: OrdinaryMove | null = null;
    let selective = ordered.length < moves.length;
    for (const { move, index } of ordered) {
      const next = yield* advance(state, move, ply);
      const child = yield* explore(next.state, depth - 1, extra, ply + 1);
      selective ||= child.selective;
      const branch = {
        evaluation: child.evaluation,
        line: [next.step, ...child.line],
        selective: child.selective,
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
        bestMove = move;
      }
    }
    if (bestMove) ctx.remember(state, bestMove.action);
    return best === null
      ? { evaluation: yield* evaluate(state), line: [], selective }
      : { ...best, selective };
  }
  const compareRoot = (a: RootCandidate, b: RootCandidate) =>
    compareAiValue(b.branch.evaluation.values[root!], a.branch.evaluation.values[root!]) ||
    a.index - b.index;
  function publish(candidates: RootCandidate[], depth: number, rootPruned: boolean) {
    const result = candidates.sort(compareRoot).map((candidate) => {
      const value = makeAiCandidate(
        candidate.move.action,
        { ...candidate.branch, selective: rootPruned || candidate.branch.selective },
        root!,
        depth,
        candidate.nodes,
        candidate.work,
      );
      return {
        ...value,
        danger: { ...value.danger, alternatives: risks.get(candidate.index) ?? null },
      };
    });
    published = result.slice(0, settings.candidateCount);
    comparedAction =
      ctx.includeIndex < 0
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
    if (settings.dangerWork > 0) {
      const examined = shallow.filter(
        (candidate, index) =>
          index < settings.candidateCount || candidate.index === ctx.includeIndex,
      );
      const quota = Math.floor(settings.dangerWork / examined.length);
      for (const candidate of examined) {
        const probe = probeAiReplies(ctx, candidate.state, candidate.branch.line[0], quota);
        risks.set(candidate.index, probe.result);
        publish(shallow, 1, false);
        yield* probe.steps;
      }
      publish(shallow, 1, false);
    }
    const selected = shallow.filter(
      (candidate, index) =>
        index < settings.rootWidth ||
        candidate.index === ctx.includeIndex ||
        candidate.state.lastMove?.captured ||
        (candidate.state.status === "playing" &&
          getCheckState(candidate.state)[candidate.state.turn]),
    );
    for (let depth = 2; depth <= settings.maxDepth; depth++) {
      if (settings.moveOrdering === "previous") selected.sort(compareRoot);
      const completed: RootCandidate[] = [];
      for (const candidate of selected) {
        const before = { ...stats };
        const child = yield* explore(candidate.state, depth - 1, settings.extensions, 1);
        const branch = { ...child, line: [candidate.branch.line[0], ...child.line] };
        completed.push({
          ...candidate,
          branch,
          nodes: stats.nodes - before.nodes,
          work: stats.work - before.work,
        });
      }
      publish(completed, depth, selected.length < legal.length);
      if (settings.moveOrdering === "previous")
        for (const candidate of selected) {
          const previous = completed.find((entry) => entry.index === candidate.index)!;
          candidate.branch = previous.branch;
        }
      yield* spend(0);
    }
  }
  function results(cutoff = false) {
    return {
      candidates: (published.length ? published : ctx.fallback()).map((candidate) => ({
        ...candidate,
        cutoff,
      })),
      comparedAction: comparedAction === null ? null : { ...comparedAction, cutoff },
    };
  }
  return {
    steps: run(),
    stats,
    results,
    staticEvaluation: ctx.staticEvaluation,
    get doneReason() {
      return doneReason;
    },
  };
}
