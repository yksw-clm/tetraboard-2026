import { defeat, finish } from "./results";
import { handPieceKinds, sides, type RepetitionLookup, type ShogiState } from "./types";
export function positionKey(state: ShogiState): string {
  return JSON.stringify([
    state.board.map((r) => r.map((p) => (p ? [p.side, p.kind, p.promoted] : null))),
    sides.map((s) => handPieceKinds.map((k) => state.hands[s][k])),
    state.turn,
  ]);
}
export function recordPosition(state: ShogiState, lookup?: RepetitionLookup): ShogiState {
  if (state.status === "finished") return state;
  const key = positionKey(state),
    prior = state.repetitions[key] ?? lookup?.(key);
  const entry = {
    count: (prior?.count ?? 0) + 1,
    nonChecks: prior?.nonChecks ?? { ...state.nonChecks },
  };
  const next: ShogiState = { ...state, repetitions: { ...state.repetitions, [key]: entry } };
  if (entry.count < 4) return next;
  const perpetual = sides.find((s) => state.nonChecks[s] === entry.nonChecks[s]);
  return perpetual
    ? defeat(next, perpetual, "perpetual_check")
    : finish(next, { winner: null, reason: "repetition" });
}
