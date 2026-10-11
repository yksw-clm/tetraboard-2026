import { describe, expect, test } from "bun:test";
import {
  applyAction,
  createInitialState,
  eliminateColor,
  getActiveColors,
  type FourGomokuState,
  type Cell,
  type Color,
} from "../src";

function play(state: FourGomokuState, x: number, y: number) {
  const result = applyAction(state, { type: "placeStone", position: { x, y } });
  if (!result.ok) throw new Error(result.reason);
  return result.state;
}
function drop(state: FourGomokuState, color: Color) {
  const result = eliminateColor(state, color, "left");
  if (!result.ok) throw new Error(result.reason);
  return result.state;
}
describe("四人五目並べの順位", () => {
  test("空盤・4色の順番・入力不変と不正着手", () => {
    const state = createInitialState();
    let next = state;
    for (let x = 0; x < 4; x++) next = play(next, x, 0);
    expect(next.board[0].slice(0, 4)).toEqual(["black", "white", "red", "blue"]);
    expect(state.board[0][0]).toBeNull();
    expect(next.turn).toBe("black");
    for (const position of [
      { x: -1, y: 0 },
      { x: 15, y: 0 },
      { x: 0.5, y: 0 },
      { x: 0, y: 0 },
    ])
      expect(applyAction(next, { type: "placeStone", position }).ok).toBe(false);
  });
  test.each([
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1],
  ])("方向 %p,%p の完成と長連でも勝ち抜け", (dx, dy) => {
    const initial = createInitialState();
    for (const length of [5, 6]) {
      const board = initial.board.map((row) => [...row]);
      for (let i = 0; i < length; i++) if (i !== 2) board[7 + i * dy][2 + i * dx] = "black";
      const next = play({ ...initial, board }, 2 + 2 * dx, 7 + 2 * dy);
      expect(next.status).toBe("playing");
      expect(next.standings).toEqual([{ color: "black", rank: 1, reason: "five" }]);
      expect(next.winningLines[0]).toHaveLength(length);
      expect(next.turn).toBe("white");
    }
  });
  test("完成と脱落が混在しても順位を上下から確定し、石を残す", () => {
    let state = createInitialState();
    const board = state.board.map((row) => [...row]);
    for (let x = 0; x < 4; x++) {
      board[0][x] = "black";
      board[1][x] = "white";
    }
    board[2][0] = "red";
    state = play({ ...state, board }, 4, 0);
    state = drop(state, "red");
    expect(state.turn).toBe("white");
    expect(eliminateColor(state, "black").ok).toBe(false);
    state = play(state, 4, 1);
    expect(state.status).toBe("finished");
    expect(state.standings.map((s) => [s.color, s.rank])).toEqual([
      ["black", 1],
      ["white", 2],
      ["blue", 3],
      ["red", 4],
    ]);
    expect(state.board[2][0]).toBe("red");
    expect(applyAction(state, { type: "placeStone", position: { x: 9, y: 9 } }).ok).toBe(false);
  });
  test("3人脱落すれば残り1人が1位、手番外脱落は手番を変えない", () => {
    let state = drop(createInitialState(), "white");
    expect(state.turn).toBe("black");
    state = drop(drop(state, "red"), "blue");
    expect(state.standings.map((s) => s.rank)).toEqual([1, 2, 3, 4]);
    expect(state.standings[0].color).toBe("black");
  });
  test("満盤の未確定者を同率1位にし、完成済みと脱落済みは保持", () => {
    const board: Cell[][] = Array.from({ length: 15 }, (_, y) =>
      Array.from(
        { length: 15 },
        (_, x) => (["black", "white", "red", "blue"] as const)[(x + 2 * y) % 4],
      ),
    );
    board[14][14] = null;
    const next = play({ ...createInitialState(), board }, 14, 14);
    expect(next.result?.reason).toBe("board_full");
    expect(next.standings.map((s) => s.rank)).toEqual([1, 1, 1, 1]);
    const state: FourGomokuState = {
      ...createInitialState(),
      board,
      status: "playing",
      result: null,
      turn: "white",
      completedColors: ["black"],
      eliminatedColors: ["red"],
      standings: [
        { color: "black", rank: 1, reason: "five" },
        { color: "red", rank: 4, reason: "left" },
      ],
    };
    const tied = play(state, 14, 14);
    expect(tied.standings.map((s) => s.rank)).toEqual([1, 2, 2, 4]);
    expect(getActiveColors(state)).toEqual(["white", "blue"]);
  });
});
