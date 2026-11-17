import type { MatchmakingState, RatedMatchmakingGame } from "@tetraboard/protocol";
export function previousMatchState(
  previous: { game: RatedMatchmakingGame; matchId: string },
  state: { started: boolean; room?: NonNullable<MatchmakingState["previousMatch"]>["room"] },
): MatchmakingState["previousMatch"] {
  if (!state.room) return { ...previous, phase: "saving" };
  return {
    ...previous,
    phase: state.room.status === "playing" ? "playing" : state.started ? "saving" : "matched",
    room: state.room,
  };
}
