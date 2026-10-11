import { expect, test } from "bun:test";
import {
  applyAction,
  createInitialState,
  eliminateColor,
  type FourGomokuState,
  type Cell,
} from "../src";
import { replayV1 } from "../src/replay";
function move(state: FourGomokuState, x: number, y: number) {
  const r = applyAction(state, { type: "placeStone", position: { x, y } });
  if (!r.ok) throw new Error(r.reason);
  return r.state;
}
test("ダブルスは混色と単色、長連を認め、相手色で途切れる", () => {
  for (const stones of [
    ["black", "red", "black", "red"],
    ["black", "black", "black", "black", "black"],
  ] as const) {
    const initial = createInitialState("doubles");
    const board = initial.board.map((r) => [...r]);
    stones.forEach((c, x) => {
      board[0][x] = c;
    });
    expect(move({ ...initial, board }, stones.length, 0).result).toEqual({
      mode: "doubles",
      reason: "five",
      winner: "black-red",
    });
    board[0][2] = "white";
    expect(move({ ...initial, board }, stones.length, 0).status).toBe("playing");
  }
});
test("ダブルスは手番外を含む1人の脱落でチーム敗北", () => {
  for (const reason of ["resigned", "left", "timeout", "disconnected"] as const) {
    const result = eliminateColor(createInitialState("doubles"), "blue", reason);
    expect(result.ok && result.state.result).toEqual({
      mode: "doubles",
      reason: "team_eliminated",
      winner: "black-red",
    });
  }
});
test("最終空点の完成を満盤より優先し、交差する全ての線を保持", () => {
  const initial = createInitialState();
  const board = initial.board.map((r) => [...r]);
  for (let i = 3; i < 8; i++) {
    board[5][i] = "black";
    board[i][5] = "black";
  }
  board[5][5] = null;
  const next = move({ ...initial, board }, 5, 5);
  expect(next.winningLines).toHaveLength(2);
  expect(next.standings).toHaveLength(1);
  const full: Cell[][] = Array.from({ length: 15 }, (_, y) =>
    Array.from({ length: 15 }, (_, x) => ((x + y) % 2 ? "white" : "black")),
  );
  for (let x = 0; x < 5; x++) full[0][x] = "black";
  full[0][4] = null;
  const last = move({ ...createInitialState("doubles"), board: full }, 4, 0);
  expect(last.result?.reason).toBe("five");
});
test("リプレイで部分順位と終局を復元し、途中順位の改変と追加手を拒否", () => {
  const initial = createInitialState();
  let game = initial;
  const steps: Parameters<typeof replayV1>[0]["steps"][number][] = [];
  for (const color of ["red", "white", "blue"] as const) {
    const action = { type: "eliminate" as const, color, reason: "timeout" as const };
    const result = eliminateColor(game, color, action.reason);
    if (!result.ok) throw new Error(result.reason);
    game = result.state;
    steps.push({ action, game });
  }
  expect(replayV1({ initial, steps }).at(-1)).toEqual(game);
  const corrupt = structuredClone(steps);
  corrupt[0].game.standings[0].rank = 1;
  expect(() => replayV1({ initial, steps: corrupt })).toThrow();
  expect(() => replayV1({ initial, steps: [...steps, steps[0]] })).toThrow();
});
test("ダブルスは満盤で引き分け、両端が敵石でも五連が成立する", () => {
  const initial = createInitialState("doubles");
  const board: Cell[][] = Array.from({ length: 15 }, (_, y) =>
    Array.from({ length: 15 }, (_, x) => ((x + 2 * y) % 4 < 2 ? "black" : "white")),
  );
  board[14][14] = null;
  const result = move({ ...initial, board }, 14, 14);
  expect(result.result).toEqual({ mode: "doubles", reason: "board_full", winner: null });
  const blocked = createInitialState();
  const cells = blocked.board.map((r) => [...r]);
  cells[0][0] = "red";
  cells[0][6] = "blue";
  for (let x = 1; x <= 5; x++) if (x !== 3) cells[0][x] = "black";
  expect(move({ ...blocked, board: cells }, 3, 0).standings).toEqual([
    { color: "black", rank: 1, reason: "five" },
  ]);
});
