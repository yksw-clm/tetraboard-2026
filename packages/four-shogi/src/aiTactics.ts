import { priority } from "./cpuSearch";
import { getActiveSides, type FourShogiState } from "./types";
import type { AiAlternativeRisk, AiLineStep } from "./aiTypes";
import type { AiContext } from "./aiSearchContext";

/** 全協力の相手モデルへ置換せず、次の自手番までに可能な合法応手の証拠を調べます。 */
export function probeAiReplies(
  ctx: AiContext,
  input: FourShogiState,
  first: AiLineStep,
  quota: number,
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
  const started = { work: ctx.stats.work, nodes: ctx.stats.nodes };
  let reachedHorizon = false;
  function* visit(state: FourShogiState, line: AiLineStep[]): Generator<number, void> {
    yield* ctx.spend(0);
    if (!getActiveSides(state).includes(ctx.root!)) {
      result.eliminationWitness ??= line;
      return;
    }
    if (state.status === "finished" || state.turn === ctx.root) return;
    if (line.length >= ctx.settings.dangerPlies) {
      reachedHorizon = true;
      return;
    }
    const legal = yield* ctx.moves(state);
    const ordered = legal
      .map((move, index) => ({
        move,
        index,
        score:
          priority(move, state.turn) +
          (move.captured?.side === ctx.root && move.captured.kind === "rook" ? 20000 : 0),
      }))
      .sort((a, b) => b.score - a.score || a.index - b.index);
    for (const { move } of ordered) {
      const next = yield* ctx.advance(state, move, line.length);
      const path = [...line, next.step];
      if (next.step.captured?.side === ctx.root && next.step.captured.kind === "rook")
        result.rookLossWitness ??= path;
      yield* visit(next.state, path);
    }
  }
  function* run(): Generator<number, void> {
    const traversal = visit(input, [first]);
    try {
      for (let step = traversal.next(); !step.done; step = traversal.next()) {
        result.work = ctx.stats.work - started.work;
        result.nodes = ctx.stats.nodes - started.nodes;
        if (ctx.stats.work - started.work + step.value > quota) {
          result.limit = "work_limit";
          return;
        }
        yield step.value;
      }
      result.complete = !reachedHorizon;
      result.limit = reachedHorizon ? "ply_limit" : null;
    } finally {
      traversal.return();
      result.work = ctx.stats.work - started.work;
      result.nodes = ctx.stats.nodes - started.nodes;
    }
  }
  return { result, steps: run() };
}
