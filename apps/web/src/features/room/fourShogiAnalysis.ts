import { getCheckState, sides, type FourShogiState } from "@tetraboard/four-shogi";
import { restoreAnalysisPosition, type AnalysisPosition } from "@tetraboard/four-shogi/analysis";
import { applyReplayEvent } from "@tetraboard/four-shogi/replay";
import type { ReplayFourShogiMatch, FourShogiAction } from "@tetraboard/protocol";
import {
  aiAnalysisResultSchema,
  type AiAnalysisResult,
  type AiAnalysisCandidate,
} from "@tetraboard/protocol/four-shogi-ai";
import { createFourShogiReplayFrame, type FourShogiReplayFrame } from "./fourShogiReplayV1";
import { replayDataEqual as equal } from "./replayDataEqual";

export const analysisBudgets = {
  "trial-500ms": { timeBudgetMs: 500, maxWork: 1000000 },
  "trial-30000ms": { timeBudgetMs: 30000, maxWork: 1000000 },
} as const;
export type AnalysisProfile = keyof typeof analysisBudgets;
export type ReplayAnalysisRoot = { position: AnalysisPosition; actual: FourShogiAction | null };
export type AnalysisCandidateView = {
  candidate: AiAnalysisCandidate;
  label: string;
  line: string[];
};
export type ReplayAnalysis = {
  result: AiAnalysisResult;
  candidates: AnalysisCandidateView[];
  actual: AnalysisCandidateView | null;
};

export async function replayAnalysisRoot(
  match: ReplayFourShogiMatch,
  frames: readonly FourShogiReplayFrame[],
  index: number,
): Promise<ReplayAnalysisRoot> {
  if (
    match.game.status !== "finished" ||
    match.settings.mode !== "singles" ||
    frames.length !== match.replay.eventCount + 1 ||
    !frames[index]
  )
    throw new Error("unsupported_replay");
  const events = frames.slice(1, index + 1).map((frame, i) => {
    if (!frame.event) throw new Error("missing_event");
    return { index: i, event: frame.event };
  });
  const position = await restoreAnalysisPosition({
    schemaVersion: 1,
    rulesVersion: match.replay.rulesVersion,
    ruleProfileId: "tetraboard-four-shogi-singles-v1",
    initial: match.replay.initial,
    events,
    eventOffset: index,
  });
  const { repetitions: _repetitions, ...game } = position.state;
  if (!equal(game, frames[index].game)) throw new Error("replay_mismatch");
  const next = frames[index + 1]?.event;
  return { position, actual: next?.type === "action" ? next.action : null };
}

function checks(state: FourShogiState) {
  const value = getCheckState(state);
  return sides.filter((side) => !state.eliminations.some((e) => e.side === side) && value[side]);
}
function actionFrame(state: FourShogiState, action: FourShogiAction) {
  if (!state.turn) throw new Error("terminal_action");
  const event = { type: "action" as const, side: state.turn, action };
  const next = applyReplayEvent(state, event);
  if (!next.ok) throw new Error("illegal_line");
  return {
    state: next.state,
    frame: createFourShogiReplayFrame(next.state, { before: state, event }),
  };
}
function candidateView(
  root: ReplayAnalysisRoot,
  candidate: AiAnalysisCandidate,
): AnalysisCandidateView {
  const label = actionFrame(root.position.state, candidate.action).frame.label;
  let state = root.position.state;
  const line: string[] = [];
  for (const [i, step] of candidate.line.entries()) {
    if (
      step.side !== state.turn ||
      step.afterPly !== i + 1 ||
      (i === 0 && !equal(step.action, candidate.action))
    )
      throw new Error("line_mismatch");
    const before = state;
    const next = actionFrame(before, step.action);
    state = next.state;
    if (
      !equal(step.captured, before.board[step.action.to.y][step.action.to.x]) ||
      !equal(step.checkedSides, checks(state)) ||
      !equal(step.eliminations, state.eliminations.slice(before.eliminations.length)) ||
      !equal(step.result, state.result) ||
      step.nextTurn !== state.turn
    )
      throw new Error("line_evidence_mismatch");
    line.push(next.frame.label);
  }
  if (candidate.evaluation && !line.length) throw new Error("missing_line");
  let boundary: AiAnalysisCandidate["danger"]["untilNextOwnTurn"] = "horizon";
  let end = candidate.line.length;
  for (const [i, step] of candidate.line.entries()) {
    if (step.eliminations.some((e) => e.side === root.position.state.turn)) boundary = "eliminated";
    else if (step.result) boundary = "terminal";
    else if (step.nextTurn === root.position.state.turn) boundary = "returned";
    if (boundary !== "horizon") {
      end = i + 1;
      break;
    }
  }
  if (
    candidate.danger.untilNextOwnTurn !== boundary ||
    !equal(candidate.danger.evidence, candidate.line.slice(0, end)) ||
    candidate.danger.alternatives !== null
  )
    throw new Error("danger_mismatch");
  return { candidate, label, line };
}

/** 版・根の履歴・比較条件を照合し、PVの全着手を正本で再生してから表示へ渡します。 */
export function readReplayAnalysis(
  value: unknown,
  root: ReplayAnalysisRoot,
  expected: { modelId: string | null; codeVersion: string; profile: AnalysisProfile },
): ReplayAnalysis {
  const result = aiAnalysisResultSchema.parse(value);
  const { position, actual } = root;
  const budget = analysisBudgets[expected.profile];
  if (
    result.input.stateHash !== position.stateHash ||
    result.input.eventOffset !== position.eventOffset ||
    result.input.threePlayerAttackProhibited !== position.state.threePlayerAttackProhibited ||
    result.input.rootSide !== position.state.turn ||
    result.versions.codeVersion !== expected.codeVersion ||
    result.versions.analysisVersion !== "singles-analysis-model-v1" ||
    result.versions.searchVersion !== "selective-maxn-policy-value-v1" ||
    result.versions.evaluationVersion !== "uncalibrated-sole-first-model-v1" ||
    result.versions.featureVersion !== "four-shogi-features-v1" ||
    result.versions.actionVersion !== "four-shogi-policy-index-v1" ||
    result.versions.opponentModelId !== "selfish-maxn-v1" ||
    result.versions.tieBreak !== "legal-order" ||
    result.model.requestedModelId !== expected.modelId ||
    result.model.loadedModelId !== expected.modelId ||
    result.model.fallbackReason ||
    (position.state.status === "playing" &&
      (result.model.usedModelId !== expected.modelId || result.model.inferenceCount === 0)) ||
    result.settings.timeBudgetMs > budget.timeBudgetMs ||
    result.settings.maxWork !== budget.maxWork ||
    !equal(result.settings.includeAction, actual) ||
    result.settings.dangerWork !== 0 ||
    result.settings.width !== 3 ||
    result.settings.rootWidth !== 6 ||
    result.settings.extensions !== 0 ||
    result.settings.maxDepth !== 64 ||
    result.settings.candidateCount !== 5 ||
    !equal(result.recommendedAction, result.candidates[0]?.action ?? null) ||
    !equal(result.currentDanger, {
      checkedSides: checks(position.state),
      eliminations: position.state.eliminations,
    })
  )
    throw new Error("analysis_mismatch");
  if (
    position.state.status === "finished"
      ? result.status !== "terminal"
      : !["completed", "limited"].includes(result.status)
  )
    throw new Error("analysis_status");
  const all = [...result.candidates, ...(result.comparedAction ? [result.comparedAction] : [])];
  if (
    all.some(
      (c) =>
        c.completedDepth !== result.diagnostics.completedDepth ||
        c.comparisonKind !== "uniform_depth" ||
        (c.completedDepth > 0 &&
          (!c.evaluation || !["model", "terminal"].includes(c.evaluation.evaluationKind))),
    )
  )
    throw new Error("comparison_mismatch");
  if (
    result.diagnostics.completedDepth > 0 &&
    actual &&
    !equal(result.comparedAction?.action, actual)
  )
    throw new Error("actual_missing");
  if (
    (!actual && result.comparedAction) ||
    !equal(
      result.evaluation,
      result.status === "terminal"
        ? result.staticEvaluation
        : (result.candidates[0]?.evaluation ?? null),
    )
  )
    throw new Error("evaluation_mismatch");
  return {
    result,
    candidates: result.candidates.map((c) => candidateView(root, c)),
    actual: result.comparedAction ? candidateView(root, result.comparedAction) : null,
  };
}
