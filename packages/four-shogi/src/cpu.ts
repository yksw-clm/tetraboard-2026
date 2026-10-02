import { getLegalMovesWithAttacks } from "./attacks";
import { getCheckState } from "./board";
import { evaluatePosition } from "./cpuEvaluation";
import { applyAction, getLegalActions } from "./index";
import { getOrdinaryMoves } from "./moves";
import {
  areEnemies,
  getActiveSides,
  teamForSide,
  type FourShogiAction,
  type FourShogiState,
  type Side,
} from "./types";

export type CpuLevel = 1 | 2;

const candidateLimit = 8;
const replyLimit = 16;

type Candidate = {
  action: FourShogiAction;
  state: FourShogiState;
  score: number;
  index: number;
};

function isImmediateWin(state: FourShogiState, side: Side): boolean {
  if (state.status !== "finished") return false;
  return state.result.mode === "singles"
    ? state.result.standings.some((standing) => standing.side === side && standing.rank === 1)
    : state.result.winner === teamForSide(side);
}

function scoreAfterReply(state: FourShogiState, side: Side): number {
  const initialScore = evaluatePosition(state)[side];
  if (state.status === "finished") return initialScore;
  const responder = state.turn;
  const replies = getLegalMovesWithAttacks(state, responder, getOrdinaryMoves(state, responder))
    .map((move, index) => {
      const checks = getCheckState(move.state);
      return {
        action: move.action,
        index,
        score: evaluatePosition(move.state)[responder],
        givesCheck: getActiveSides(move.state).some(
          (target) => areEnemies(state.mode, responder, target) && checks[target],
        ),
      };
    })
    .sort(
      (left, right) =>
        Number(right.givesCheck) - Number(left.givesCheck) ||
        right.score - left.score ||
        left.index - right.index,
    )
    .slice(0, replyLimit);

  let responseScore = -Infinity;
  let responseIndex = Infinity;
  let score = initialScore;
  for (const reply of replies) {
    const result = applyAction(state, responder, reply.action);
    if (!result.ok) continue;
    const values = evaluatePosition(result.state);
    if (
      values[responder] > responseScore ||
      (values[responder] === responseScore && reply.index < responseIndex)
    ) {
      responseScore = values[responder];
      responseIndex = reply.index;
      score = values[side];
    }
  }
  return score;
}

export function chooseCpuAction(
  state: FourShogiState,
  level: CpuLevel,
  random: () => number = Math.random,
): FourShogiAction | null {
  if (state.status === "finished") return null;
  const actions = getLegalActions(state);
  if (actions.length === 0) return null;
  if (level === 1) {
    const sample = random();
    if (!Number.isFinite(sample)) throw new TypeError("Random value must be finite");
    return actions[Math.min(actions.length - 1, Math.max(0, Math.floor(sample * actions.length)))];
  }

  const side = state.turn;
  const candidates: Candidate[] = [];
  for (const [index, action] of actions.entries()) {
    const result = applyAction(state, side, action);
    if (!result.ok) continue;
    candidates.push({
      action,
      state: result.state,
      score: evaluatePosition(result.state)[side],
      index,
    });
  }
  const win = candidates.find((candidate) => isImmediateWin(candidate.state, side));
  if (win) return win.action;

  // すべての一手先で勝敗を確認してから、上位候補だけ応手を読みます。
  const selected = candidates
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, candidateLimit);
  let best: Candidate | undefined;
  let bestScore = -Infinity;
  for (const candidate of selected) {
    const score = scoreAfterReply(candidate.state, side);
    if (!best || score > bestScore || (score === bestScore && candidate.index < best.index)) {
      best = candidate;
      bestScore = score;
    }
  }
  return best?.action ?? null;
}
