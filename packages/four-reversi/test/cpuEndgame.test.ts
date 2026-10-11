import { expect, test } from "bun:test";
import { endgameCases } from "../bench/positions";
import { solveEndgame } from "../bench/oracle";
import { chooseCpuMoveWithDiagnostics } from "../src/cpu";
import { applyAction, createInitialState, getLegalMoves, type Cell } from "../src/index";

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

test("空き1〜4マスの両モード200局面を全読みし、独立oracleの最適手集合と一致する", () => {
  const corpus = endgameCases(30000, 200);
  const labels = new Set(corpus.flatMap((entry) => entry.labels));
  expect(labels).toContain("singles");
  expect(labels).toContain("doubles");
  expect(labels).toContain("2-colors");
  expect(labels).toContain("3-colors");
  expect(labels).toContain("pass");
  for (const { state } of corpus) {
    const before = structuredClone(state);
    const expected = solveEndgame(state);
    const result = chooseCpuMoveWithDiagnostics(freeze(state));
    expect(expected.moves).toContainEqual(result.move!);
    expect(result.stats.exactEndgame).toBe(true);
    expect(result.stats.cutoff).toBe(false);
    expect(result.stats.work).toBeLessThanOrEqual(2048);
    expect(state).toEqual(before);
  }
});

test("全読みの中断を完了と扱わず、合法な代替手と予算上限を守る", () => {
  for (const { state } of endgameCases(30000, 20)) {
    const result = chooseCpuMoveWithDiagnostics(state, { maxWork: 1 });
    expect(getLegalMoves(state)).toContainEqual(result.move!);
    expect(result.stats.exactEndgame).toBe(false);
    expect(result.stats.completedDepth).toBe(0);
    expect(result.stats.work).toBeLessThanOrEqual(1);
  }
});

test("全読みは内部幅とキャッシュに依存せず、自動パス・空点を残す終局も確定する", () => {
  for (const { state } of endgameCases(30000, 200)) {
    const result = chooseCpuMoveWithDiagnostics(state, { width: 1, cacheLimit: 0 });
    expect(result.stats.exactEndgame).toBe(true);
    expect(result.move).toEqual(chooseCpuMoveWithDiagnostics(state).move);
    const applied = applyAction(state, { type: "placeStone", position: result.move! });
    if (applied.ok && applied.state.status === "finished") {
      expect(chooseCpuMoveWithDiagnostics(applied.state).move).toBeNull();
    }
  }
  const board: Cell[][] = Array.from({ length: 8 }, () => Array<Cell>(8).fill("black"));
  board[0][1] = "white";
  board[0][2] = null;
  board[2][1] = "red";
  board[4][1] = "blue";
  board[3][1] = "white";
  board[7][7] = null;
  const state = { ...createInitialState("singles"), board };
  const result = chooseCpuMoveWithDiagnostics(state);
  expect(result.stats.exactEndgame).toBe(true);
  expect(result.move).toEqual({ x: 2, y: 0 });
  const applied = applyAction(state, { type: "placeStone", position: result.move! });
  expect(applied.ok && applied.state.result?.reason).toBe("all_passed");
  expect(applied.ok && applied.state.board[7][7]).toBeNull();
});
