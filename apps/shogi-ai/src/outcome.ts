import type { FourShogiState, Side } from "@tetraboard/four-shogi";
import type { Sample } from "./statistics";
export function resolvedOutcome(
  state: FourShogiState,
  seat: Side,
  seed: number,
  plies: number,
  allowEarly: boolean,
): Sample | null {
  if (state.mode !== "singles") throw new Error("Singles outcome required");
  if (state.status === "finished" && state.result.mode === "singles") {
    const rank = state.result.standings.find((s) => s.side === seat)!.rank;
    return {
      seed,
      seat,
      rank,
      reward: (4 - rank) / 3,
      draw: rank === 1 && state.result.reason !== "last_player",
      unfinished: false,
      plies,
      termination: "finished",
    };
  }
  const eliminated = state.eliminations.find((e) => e.side === seat);
  if (allowEarly && eliminated?.rank != null)
    return {
      seed,
      seat,
      rank: eliminated.rank,
      reward: (4 - eliminated.rank) / 3,
      draw: false,
      unfinished: false,
      plies,
      termination: "learner-eliminated",
    };
  return null;
}
