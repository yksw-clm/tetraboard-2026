import { expect, test } from "bun:test";
import { colors, createInitialState, getLegalMoves, type Cell } from "../src/index";
import { chooseCpuMoveWithDiagnostics } from "../src/cpu";
import { positionKey } from "../src/cpuSearch";
import { positionAt } from "../bench/measurement";

test("少ない予算でも合法手を返し、入力と乱数に依存しない", () => {
  for (const mode of ["singles", "doubles"] as const) {
    const state = positionAt(mode, 991, 24);
    const before = structuredClone(state);
    for (const maxWork of [1, 4, 32, 128, 2048]) {
      const result = chooseCpuMoveWithDiagnostics(state, { maxWork });
      expect(result.stats.work).toBeLessThanOrEqual(maxWork);
      expect(getLegalMoves(state)).toContainEqual(result.move!);
      expect(result).toEqual(chooseCpuMoveWithDiagnostics(state, { maxWork }));
    }
    expect(state).toEqual(before);
  }
});

test("3〜4色はMaxⁿ、2色とチームはαβを使い、根を候補幅で除外しない", () => {
  for (const active of [2, 3, 4]) {
    const state = positionAt("singles", 992, 36, active);
    const result = chooseCpuMoveWithDiagnostics(state, { maxDepth: 1, width: 1 });
    expect(result.stats.algorithm).toBe(active === 2 ? "alpha-beta" : "maxn");
    expect(result.stats.rootMoves).toBe(getLegalMoves(state).length);
  }
  expect(chooseCpuMoveWithDiagnostics(createInitialState("doubles")).stats.algorithm).toBe(
    "alpha-beta",
  );
});

test("キャッシュの有無でも同じ手を選び、状態・深さと評価境界を分離する", () => {
  const state = positionAt("singles", 993, 48);
  const cached = chooseCpuMoveWithDiagnostics(state, { maxWork: 4096, maxDepth: 2 });
  const fresh = chooseCpuMoveWithDiagnostics(state, { maxWork: 4096, maxDepth: 2, cacheLimit: 0 });
  expect(cached.move).toEqual(fresh.move);
  expect(cached.stats.cacheEntries).toBeLessThanOrEqual(2048);
  expect(fresh.stats.cacheEntries).toBe(0);
  expect(positionKey(state)).not.toBe(positionKey({ ...state, eliminatedColors: ["blue"] }));
  expect(positionKey(state)).not.toBe(positionKey({ ...state, consecutivePasses: ["blue"] }));
});

test("全評価が同じなら元の上から左の列挙順を使う", () => {
  const weights = {
    stones: [0, 0, 0],
    mobility: [0, 0, 0],
    corners: [0, 0, 0],
    stableEdges: [0, 0, 0],
    frontier: [0, 0, 0],
    xSquares: [0, 0, 0],
    cSquares: [0, 0, 0],
  } as const;
  const state = createInitialState("singles");
  expect(
    chooseCpuMoveWithDiagnostics(state, { maxDepth: 2, evaluationWeights: weights }).move,
  ).toEqual(getLegalMoves(state)[0]);
});

test("進行中の合法手なしはnull、不正予算は拒否する", () => {
  const empty: Cell[][] = Array.from({ length: 8 }, () => Array<Cell>(8).fill(null));
  expect(
    chooseCpuMoveWithDiagnostics({ ...createInitialState("singles"), board: empty }).move,
  ).toBeNull();
  for (const maxWork of [0, -1, NaN, 1.5])
    expect(() =>
      chooseCpuMoveWithDiagnostics(createInitialState("singles"), { maxWork }),
    ).toThrow();
  expect(colors).toHaveLength(4);
});
