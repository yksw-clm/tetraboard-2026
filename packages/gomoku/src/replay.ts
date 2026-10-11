import {
  applyAction,
  createInitialState,
  eliminateColor,
  type Color,
  type GomokuState,
  type Position,
} from "./index";
type Step = {
  action: { type: "place"; color: Color; position: Position } | { type: "eliminate"; color: Color };
  game: GomokuState;
};
function comparable(state: GomokuState): string {
  const result = state.result;
  return JSON.stringify([
    state.rulesVersion,
    state.forbiddenRules,
    state.status,
    state.turn,
    state.board,
    state.moveNumber,
    state.lastMove && [state.lastMove.x, state.lastMove.y],
    state.eliminatedColors,
    result && [
      result.reason,
      result.winner,
      result.stoneCounts.black,
      result.stoneCounts.white,
      result.winningLines.map((line) => line.map((p) => [p.x, p.y])),
    ],
  ]);
}
export function sameState(a: GomokuState, b: GomokuState): boolean {
  return comparable(a) === comparable(b);
}

/** 保存局面を正本のルールで再実行し、拒否された着手や破損した途中局面を表示しません。 */
export function replayV1(replay: { initial: GomokuState; steps: readonly Step[] }): GomokuState[] {
  let state = createInitialState(replay.initial.forbiddenRules);
  if (!sameState(state, replay.initial)) throw new Error("Invalid Gomoku initial state");
  const frames = [state];
  for (const step of replay.steps) {
    if (
      state.status !== "playing" ||
      (step.action.type === "place" && step.action.color !== state.turn)
    )
      throw new Error("Invalid Gomoku turn");
    const result =
      step.action.type === "place"
        ? applyAction(state, { type: "placeStone", position: step.action.position })
        : eliminateColor(state, step.action.color);
    if (!result.ok || !sameState(result.state, step.game))
      throw new Error("Invalid Gomoku replay state");
    state = result.state;
    frames.push(state);
  }
  return frames;
}
