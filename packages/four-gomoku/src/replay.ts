import {
  applyAction,
  createInitialState,
  eliminateColor,
  type Color,
  type EliminationReason,
  type FourGomokuState,
  type Position,
} from "./index";
type Step = {
  action:
    | { type: "place"; color: Color; position: Position }
    | { type: "eliminate"; color: Color; reason: EliminationReason };
  game: FourGomokuState;
};
function comparable(state: FourGomokuState): string {
  const standings = (items: FourGomokuState["standings"]) =>
    items.map((s) => [s.color, s.rank, s.reason]);
  return JSON.stringify([
    state.rulesVersion,
    state.mode,
    state.status,
    state.turn,
    state.board,
    state.moveNumber,
    state.lastMove && [state.lastMove.x, state.lastMove.y],
    state.eliminatedColors,
    state.completedColors,
    standings(state.standings),
    state.winningLines.map((line) => line.map((p) => [p.x, p.y])),
    state.result && [
      state.result.mode,
      state.result.reason,
      state.result.mode === "singles" ? standings(state.result.standings) : state.result.winner,
    ],
  ]);
}
export function sameState(a: FourGomokuState, b: FourGomokuState): boolean {
  return comparable(a) === comparable(b);
}
/** 確定順位を含む各局面を再実行し、破損した途中経過も拒否します。 */
export function replayV1(replay: {
  initial: FourGomokuState;
  steps: readonly Step[];
}): FourGomokuState[] {
  let state = createInitialState(replay.initial.mode);
  if (!sameState(state, replay.initial)) throw new Error("Invalid Four Gomoku initial state");
  const frames = [state];
  for (const step of replay.steps) {
    if (
      state.status !== "playing" ||
      (step.action.type === "place" && step.action.color !== state.turn)
    )
      throw new Error("Invalid Four Gomoku turn");
    const result =
      step.action.type === "place"
        ? applyAction(state, { type: "placeStone", position: step.action.position })
        : eliminateColor(state, step.action.color, step.action.reason);
    if (!result.ok || !sameState(result.state, step.game))
      throw new Error("Invalid Four Gomoku replay state");
    state = result.state;
    frames.push(state);
  }
  return frames;
}
