import { expect, test } from "bun:test";
import { createInitialState, applyAction, type Color } from "../src";
import { analyzeCpuMove, chooseCpuMove, cpuSearchLimits } from "../src/cpu";
test("CPUは全空点と近傍から合法に選び、入力不変・決定性・探索上限を守る", () => {
  const initial = createInitialState();
  expect(chooseCpuMove(initial, 1, () => 0)).toEqual({ x: 0, y: 0 });
  const played = applyAction(initial, { type: "placeStone", position: { x: 7, y: 7 } });
  if (!played.ok) throw new Error();
  const state = played.state;
  const before = JSON.stringify(state);
  const a = analyzeCpuMove(state, 2);
  expect(a).toEqual(analyzeCpuMove(state, 2));
  expect(a.nodes).toBeLessThanOrEqual(cpuSearchLimits.nodes);
  expect(a.move && state.board[a.move.y][a.move.x]).toBeNull();
  expect(JSON.stringify(state)).toBe(before);
});
test("全ての敵色の即勝ちを防ぎ、自分の完成を優先", () => {
  for (const color of ["white", "red", "blue"] as Color[]) {
    const initial = createInitialState();
    const board = initial.board.map((r) => [...r]);
    for (let x = 0; x < 4; x++) board[0][x] = color;
    expect(chooseCpuMove({ ...initial, board }, 2)).toEqual({ x: 4, y: 0 });
    for (let x = 0; x < 4; x++) board[14][x] = "black";
    expect(chooseCpuMove({ ...initial, board }, 2)).toEqual({ x: 4, y: 14 });
  }
});
test("ダブルスの混色完成と敵チームの混色防御", () => {
  const initial = createInitialState("doubles");
  const board = initial.board.map((r) => [...r]);
  for (let x = 0; x < 4; x++) board[0][x] = x % 2 ? "blue" : "white";
  expect(chooseCpuMove({ ...initial, board }, 2)).toEqual({ x: 4, y: 0 });
  for (let x = 0; x < 4; x++) board[14][x] = x % 2 ? "red" : "black";
  expect(chooseCpuMove({ ...initial, board }, 2)).toEqual({ x: 4, y: 14 });
});
test("順位が確定した敵は脅威から除き、残った手番順で防御する", () => {
  const initial = createInitialState();
  const board = initial.board.map((r) => [...r]);
  for (let x = 0; x < 4; x++) {
    board[0][x] = "white";
    board[2][x] = "red";
    board[4][x] = "blue";
  }
  const state = {
    ...initial,
    board,
    completedColors: ["white" as const],
    standings: [{ color: "white" as const, rank: 1, reason: "five" as const }],
  };
  expect(chooseCpuMove(state, 2)).toEqual({ x: 4, y: 2 });
});
