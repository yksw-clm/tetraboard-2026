import { expect, test } from "bun:test";
import {
  colors,
  createInitialState,
  eliminateColor,
  type Cell,
  type FourReversiState,
} from "../src/index";
import { evaluatePosition, positionFeatures, resolveWeights } from "../src/cpuEvaluation";

function position(
  cells: [number, number, Cell][],
  mode: "singles" | "doubles" = "singles",
): FourReversiState {
  const board: Cell[][] = Array.from({ length: 8 }, () => Array<Cell>(8).fill(null));
  for (const [x, y, color] of cells) board[y][x] = color;
  return { ...createInitialState(mode), board };
}

test("角から保証した同色の辺だけを数え、角と2方向を二重計上しない", () => {
  const state = position([
    [0, 0, "black"],
    [1, 0, "black"],
    [2, 0, "black"],
    [0, 1, "black"],
    [0, 2, "black"],
    [4, 0, "black"],
  ]);
  const { features } = positionFeatures(state);
  expect(features.black.corners).toBe(1);
  expect(features.black.stableEdges).toBe(4);
  const fullEdge = position(Array.from({ length: 8 }, (_, x) => [x, 0, "black"]));
  expect(positionFeatures(fullEdge).features.black.stableEdges).toBe(6);
});

test("空き角のX/Cマスの減点を、角が埋まったとき解除する", () => {
  const state = position([
    [1, 1, "black"],
    [1, 0, "black"],
    [0, 1, "black"],
  ]);
  const features = positionFeatures(state).features.black;
  expect(features.xSquares).toBe(1);
  expect(features.cSquares).toBe(2);
  const filled = position([
    [0, 0, "white"],
    [1, 1, "black"],
    [1, 0, "black"],
    [0, 1, "black"],
  ]);
  expect(positionFeatures(filled).features.black.xSquares).toBe(0);
  expect(positionFeatures(filled).features.black.cSquares).toBe(0);
});

test("空点への8近傍の接触は各石1回だけ数える", () => {
  const { features, phase } = positionFeatures(
    position([
      [3, 3, "red"],
      [4, 4, "red"],
    ]),
  );
  expect(features.red.frontier).toBe(2);
  expect(phase).toBe(0);
});

test("ダブルスの味方は同値で敵は逆符号、入力を変更しない", () => {
  const state = createInitialState("doubles");
  const before = structuredClone(state);
  const values = evaluatePosition(state);
  expect(values.black).toBe(values.red);
  expect(values.white).toBe(values.blue);
  expect(values.black).toBe(-values.white);
  expect(state).toEqual(before);
});

test("脱落順位を保持し、終局のチーム勝敗は石数より優先する", () => {
  const state = createInitialState("singles");
  const result = eliminateColor(state, "blue");
  if (!result.ok) throw new Error("脱落fixtureを作れません");
  expect(evaluatePosition(result.state).blue).toBe(-2_000_000);
  const finished = eliminateColor(createInitialState("doubles"), "black");
  if (!finished.ok) throw new Error("終局fixtureを作れません");
  expect(evaluatePosition(finished.state).white).toBe(1_000_000);
  expect(evaluatePosition(finished.state).red).toBe(-1_000_000);
});

test("係数の未知名・非有限値・不足を拒否し、途中評価を制限する", () => {
  expect(() => resolveWeights({ stones: [1, 2, Infinity] })).toThrow();
  expect(() => resolveWeights(JSON.parse('{"unknown":[1,2,3]}'))).toThrow();
  expect(() => resolveWeights(JSON.parse('{"stones":[1,2]}'))).toThrow();
  const weights = resolveWeights({ corners: [1e9, 1e9, 1e9] });
  const values = evaluatePosition(position([[0, 0, "black"]]), weights);
  for (const color of colors) expect(Math.abs(values[color])).toBeLessThan(100_000);
});
