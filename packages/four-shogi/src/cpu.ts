import { searchCpuAction } from "./cpuSearch";
import type { RepetitionLookup } from "./repetition";
import { getLegalMoves } from "./transition";
import type { FourShogiAction, FourShogiState } from "./types";

export type CpuLevel = 1 | 2;
export const chooseCpuActionWithDiagnostics = searchCpuAction;

export function chooseCpuAction(
  state: FourShogiState,
  level: CpuLevel,
  random: () => number = Math.random,
  repetitionLookup?: RepetitionLookup,
): FourShogiAction | null {
  if (state.status === "finished") return null;
  if (level === 2) return searchCpuAction(state, {}, repetitionLookup).action;
  const moves = getLegalMoves(state);
  if (moves.length === 0) return null;
  const sample = random();
  if (!Number.isFinite(sample)) throw new TypeError("Random value must be finite");
  return moves[Math.min(moves.length - 1, Math.max(0, Math.floor(sample * moves.length)))].action;
}
