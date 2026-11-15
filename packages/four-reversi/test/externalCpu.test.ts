import { expect, test } from "bun:test";
import { createInitialState, getLegalMoves, eliminateColor, type FourReversiState } from "../src";
import { fourReversiDefinition as game } from "../src/definition";
const external = game.cpu.external!;

test("外部AIの局面キーは旧キーと一致し、全照合項目の変更を識別する", () => {
  const state = createInitialState("singles");
  const oldKey = (s: FourReversiState) =>
    JSON.stringify([
      s.mode,
      s.board,
      s.turn,
      s.moveNumber,
      s.eliminatedColors,
      s.consecutivePasses,
      s.lastMove,
    ]);
  expect(external.getPositionKey(state)).toBe(oldKey(state));
  for (const patch of [
    { mode: "doubles" },
    { turn: "white" },
    { moveNumber: 1 },
    { eliminatedColors: ["red"] },
    { consecutivePasses: ["red"] },
    { lastMove: { x: 0, y: 0 } },
    { board: state.board.map((r) => r.map(() => null)) },
  ]) {
    const changed = { ...state, ...patch } as FourReversiState;
    expect(external.getPositionKey(changed)).toBe(oldKey(changed));
    expect(external.getPositionKey(changed)).not.toBe(external.getPositionKey(state));
  }
});

test("要求はレベル・拡張ルールごとの旧ゲーム本文と同じ", () => {
  for (const level of [1, 2] as const)
    for (const extendedRules of [false, true]) {
      const state = createInitialState("singles");
      const before = structuredClone(state);
      expect(external.createRequest(state, "black", level, { extendedRules })).toEqual({
        game_id: "four-reversi",
        ruleset_version: extendedRules ? "four-reversi-singles-v2" : "four-reversi-singles-v1",
        state_version: extendedRules ? 2 : 1,
        agent_id: level === 1 ? "four-reversi-random-v1" : "four-reversi-greedy-v1",
        state: {
          board: state.board,
          ...(extendedRules ? { eliminatedColors: [] } : {}),
          turn: "black",
          moveNumber: 0,
          lastMove: null,
          consecutivePasses: [],
        },
      });
      expect(state).toEqual(before);
    }
});

test("応答の手は合法性を判定せず操作にし、予備は最初の合法手になる", () => {
  const state = createInitialState("singles");
  const before = structuredClone(state);
  for (const position of [getLegalMoves(state)[0]!, { x: 3, y: 3 }])
    expect(external.readMove(position)).toEqual({ type: "placeStone", position });
  expect(external.fallbackAction(state, "black")).toEqual({
    type: "placeStone",
    position: getLegalMoves(state)[0],
  });
  expect(external.fallbackAction(state, "white")).toBeNull();
  expect(
    external.fallbackAction(
      { ...state, board: state.board.map((r) => r.map(() => "black" as const)) },
      "black",
    ),
  ).toBeNull();
  const finished = eliminateColor(createInitialState("doubles"), "black");
  if (!finished.ok) throw Error("Expected elimination");
  expect(external.fallbackAction(finished.state, "white")).toBeNull();
  expect(state).toEqual(before);
});
