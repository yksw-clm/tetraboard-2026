import { getLegalMoves, type FourReversiState, type Position } from "./engine";
import { searchCpuMove, type SearchOptions } from "./cpuSearch";

export type CpuLevel = 1 | 2;

export function chooseCpuMoveWithDiagnostics(state: FourReversiState, options: SearchOptions = {}) {
  return searchCpuMove(state, options);
}

export function chooseCpuMove(
  state: FourReversiState,
  level: CpuLevel,
  random: () => number = Math.random,
): Position | null {
  if (state.status === "finished") return null;
  if (level === 2) return chooseCpuMoveWithDiagnostics(state).move;
  const moves = getLegalMoves(state);
  if (!moves.length) return null;
  return moves[Math.min(moves.length - 1, Math.max(0, Math.floor(random() * moves.length)))];
}
