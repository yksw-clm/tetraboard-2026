import { compareAiValue } from "./aiEvaluation";
import { createAiContext, makeAiCandidate, makeAiDanger, type AiContext } from "./aiSearchContext";
import { probeAiReplies } from "./aiTactics";
import { getCheckState } from "./board";
import { sides, type FourShogiState, type Side } from "./types";
import type { OrdinaryMove } from "./moves";
import type {
  AiCandidate,
  AiEvaluation,
  AiLineStep,
  AiSearchSettings,
  AiStopReason,
  AiValue,
} from "./aiTypes";

type Edge = { move: OrdinaryMove; index: number; child: Node | null };
type Node = {
  state: FourShogiState;
  initial: AiEvaluation;
  step: AiLineStep;
  index: number;
  edges: Edge[] | null;
  selective: boolean;
  visits: number;
  sums: Record<Side, { primary: number; rank: number }>;
};
type UctEntry = { index: number; visits: number; values: Readonly<Record<Side, AiValue>> };
/** 値ベクトルの担当方向だけでUCTを比較し、他人の値の符号を反転しません。 */
export function chooseUctIndex(
  entries: readonly UctEntry[],
  actor: Side,
  parentVisits: number,
  exploration: number,
): number {
  let best = -1;
  let score = -Infinity;
  for (const [index, entry] of entries.entries()) {
    const value =
      entry.visits === 0
        ? Infinity
        : entry.values[actor].primary +
          exploration * Math.sqrt(Math.log(Math.max(1, parentVisits)) / entry.visits);
    if (value > score || best < 0) {
      best = index;
      score = value;
      continue;
    }
    if (value !== score) continue;
    const incumbent = entries[best];
    const samePrimary =
      entry.visits > 0 &&
      incumbent.visits > 0 &&
      entry.values[actor].primary === incumbent.values[actor].primary;
    const rankDifference = samePrimary
      ? incumbent.values[actor].secondaryRank - entry.values[actor].secondaryRank
      : 0;
    if (rankDifference > 0 || (rankDifference === 0 && entry.index < incumbent.index)) best = index;
  }
  return best;
}
function randomSource(seed: number) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let mixed = Math.imul(value ^ (value >>> 15), 1 | value);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}
function newNode(
  state: FourShogiState,
  initial: AiEvaluation,
  step: AiLineStep,
  index: number,
): Node {
  return {
    state,
    initial,
    step,
    index,
    edges: null,
    selective: false,
    visits: 0,
    sums: Object.fromEntries(sides.map((side) => [side, { primary: 0, rank: 0 }])) as Node["sums"],
  };
}
function mean(node: Node): AiEvaluation {
  if (node.visits === 0) return node.initial;
  const values = Object.fromEntries(
    sides.map((side) => [
      side,
      {
        primary: node.sums[side].primary / node.visits,
        secondaryRank: node.sums[side].rank / node.visits,
        heuristicScore: null,
      },
    ]),
  ) as Record<Side, AiValue>;
  return {
    evaluationKind: "sample_mean",
    values,
    ranks: sides.map((side) => ({
      side,
      rank:
        node.initial.ranks.find((entry) => entry.side === side && entry.kind === "confirmed")
          ?.rank ??
        1 + sides.filter((other) => compareAiValue(values[other], values[side]) > 0).length,
      kind: node.initial.ranks.find((entry) => entry.side === side)!.kind,
    })),
    probabilities: null,
  };
}
function greedyChild(node: Node): Node | null {
  if (node.state.status === "finished") return null;
  const children =
    node.edges?.flatMap((edge) => (edge.child && edge.child.visits > 0 ? [edge.child] : [])) ?? [];
  children.sort(
    (a, b) =>
      compareAiValue(mean(b).values[node.state.turn!], mean(a).values[node.state.turn!]) ||
      a.index - b.index,
  );
  return children[0] ?? null;
}

export function createAiMcts(
  input: FourShogiState,
  settings: AiSearchSettings,
  context?: AiContext,
) {
  const ctx = context ?? createAiContext(input, settings);
  const { stats, root, legal, spend } = ctx;
  const random = randomSource(settings.seed);
  let roots: Node[] = [];
  let selected: Node[] = [];
  let published: AiCandidate[] = [];
  let comparedAction: AiCandidate | null = null;
  const risks = new Map<number, NonNullable<AiCandidate["danger"]["alternatives"]>>();
  let doneReason: AiStopReason =
    input.status === "finished"
      ? "terminal"
      : legal.length === 0
        ? "no_legal_actions"
        : "simulation_limit";
  function publish(nodes: Node[], sampled: boolean) {
    const ordered = [...nodes].sort(
      (a, b) => compareAiValue(mean(b).values[root!], mean(a).values[root!]) || a.index - b.index,
    );
    const candidates = ordered.map((node) => {
      let leaf = node;
      const line = [node.step];
      let selective = sampled || (selected.length > 0 && selected.length < roots.length);
      for (let next = greedyChild(leaf); next !== null; next = greedyChild(leaf)) {
        selective ||= leaf.selective;
        line.push(next.step);
        leaf = next;
      }
      selective ||= leaf.selective;
      const candidate = makeAiCandidate(
        legal[node.index].action,
        { evaluation: sampled ? mean(node) : node.initial, line, selective },
        root!,
        1,
        0,
        0,
      );
      return {
        ...candidate,
        comparisonKind: sampled ? ("sample_mean" as const) : ("uniform_depth" as const),
        visits: node.visits,
        lineEvaluation: leaf.initial,
        danger: { ...makeAiDanger(line, root!), alternatives: risks.get(node.index) ?? null },
      };
    });
    published = candidates.slice(0, settings.candidateCount);
    comparedAction =
      ctx.includeIndex < 0
        ? null
        : (candidates.find(
            (candidate) =>
              JSON.stringify(candidate.action) === JSON.stringify(settings.includeAction),
          ) ?? null);
    stats.completedDepth = 1;
  }
  function* simulation(first: Node): Generator<number, void> {
    const path = [first];
    let leaf = first;
    while (leaf.state.status === "playing" && path.length < settings.maxDepth) {
      if (leaf.edges === null) {
        const moves = yield* ctx.moves(leaf.state);
        const ordered = yield* ctx.ordered(leaf.state, moves);
        leaf.selective = ordered.length < moves.length;
        leaf.edges = ordered.map(({ move, index }) => ({ move, index, child: null }));
      }
      if (leaf.edges.length === 0) break;
      const unexpanded = leaf.edges.find((edge) => edge.child === null);
      if (unexpanded) {
        const next = yield* ctx.advance(leaf.state, unexpanded.move, path.length);
        const initial = yield* ctx.evaluate(next.state);
        const child = newNode(next.state, initial, next.step, unexpanded.index);
        unexpanded.child = child;
        leaf = child;
        path.push(leaf);
        break;
      }
      const children = leaf.edges.map((edge) => edge.child!);
      const index = chooseUctIndex(
        children.map((child) => ({
          index: child.index,
          visits: child.visits,
          values: mean(child).values,
        })),
        leaf.state.turn,
        leaf.visits,
        settings.exploration,
      );
      leaf = children[index];
      path.push(leaf);
    }
    let state = leaf.state;
    let ply = path.length;
    for (let step = 0; step < settings.rolloutPlies && state.status === "playing"; step++) {
      const moves = yield* ctx.moves(state);
      if (moves.length === 0) break;
      const next = yield* ctx.advance(state, moves[Math.floor(random() * moves.length)], ply);
      state = next.state;
      ply++;
    }
    const evaluation = yield* ctx.evaluate(state);
    yield* spend(path.length);
    // 完成した試行だけを4方向そのまま逆伝播し、途中試行の数値を公開しません。
    for (const node of path) {
      node.visits++;
      for (const side of sides) {
        node.sums[side].primary += evaluation.values[side].primary;
        node.sums[side].rank += evaluation.values[side].secondaryRank;
      }
    }
    stats.simulations++;
    stats.maxVisitedPly = Math.max(stats.maxVisitedPly, ply);
  }
  function* run(): Generator<number, void> {
    if (input.status === "finished" || legal.length === 0) return;
    yield* spend(1 + Math.ceil(legal.length / 16));
    for (const [index, move] of legal.entries()) {
      const next = yield* ctx.advance(ctx.start, move, 0);
      roots.push(newNode(next.state, yield* ctx.evaluate(next.state), next.step, index));
    }
    publish(roots, false);
    yield* spend(0);
    if (
      published[0].evaluation!.evaluationKind === "terminal" &&
      published[0].evaluation!.values[root!].primary === 1
    ) {
      doneReason = "sole_win";
      return;
    }
    roots.sort(
      (a, b) =>
        compareAiValue(b.initial.values[root!], a.initial.values[root!]) || a.index - b.index,
    );
    selected = roots.filter(
      (node, index) =>
        index < settings.rootWidth ||
        node.index === ctx.includeIndex ||
        node.state.lastMove?.captured ||
        (node.state.status === "playing" && getCheckState(node.state)[node.state.turn]),
    );
    if (settings.dangerWork > 0) {
      const examined = roots.filter(
        (node, index) => index < settings.candidateCount || node.index === ctx.includeIndex,
      );
      for (const node of examined) {
        const probe = probeAiReplies(
          ctx,
          node.state,
          node.step,
          Math.floor(settings.dangerWork / examined.length),
        );
        risks.set(node.index, probe.result);
        publish(roots, false);
        yield* probe.steps;
      }
    }
    for (let trial = 0; trial < settings.maxSimulations; trial++) {
      const index = chooseUctIndex(
        selected.map((node) => ({
          index: node.index,
          visits: node.visits,
          values: mean(node).values,
        })),
        root!,
        stats.simulations,
        settings.exploration,
      );
      yield* simulation(selected[index]);
      if (selected.every((node) => node.visits > 0)) publish(selected, true);
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
    staticEvaluation: ctx.staticEvaluation,
    results,
    get doneReason() {
      return doneReason;
    },
  };
}
