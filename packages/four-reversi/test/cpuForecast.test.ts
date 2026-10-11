import { expect, test } from "bun:test";
import { positionAt } from "../bench/measurement";
import { chooseCpuMoveWithDiagnostics } from "../src/cpu";
import { searchCpuMove } from "../src/cpuSearch";
import {
  applyAction,
  colors,
  countStones,
  createInitialState,
  chooseCpuMove,
  getLegalMoves,
  getLegalMovesForColor,
  type Color,
  type FourReversiState,
  type Position,
} from "../src/index";

// 公開着手と個別の合法手生成を使い、キャッシュや候補順の変更なしで応手を再現します。
function referencePolicy(state: FourReversiState): Position {
  if (state.status !== "playing") throw new Error("進行局面が必要です");
  function advance(input: FourReversiState, position: Position) {
    const result = applyAction(input, { type: "placeStone", position });
    if (!result.ok) throw new Error("不正な応手です");
    return result.state;
  }
  function value(input: FourReversiState, color: Color) {
    if (input.status === "finished") {
      if (input.result.mode !== "singles") throw new Error("シングルスが必要です");
      const standing = input.result.standings.find((entry) => entry.color === color)!;
      return (5 - standing.rank) * 10000 + (standing.stoneCount ?? 0);
    }
    if (input.eliminatedColors.includes(color)) return -10000;
    let score = countStones(input.board)[color] + getLegalMovesForColor(input, color).length * 3;
    input.board.forEach((row, y) =>
      row.forEach((cell, x) => {
        if (cell !== color) return;
        const edges = Number(x === 0 || x === 7) + Number(y === 0 || y === 7);
        score += edges === 2 ? 25 : edges === 1 ? 5 : 0;
      }),
    );
    return score;
  }
  let best = getLegalMoves(state)[0];
  let bestScore = -Infinity;
  for (const move of getLegalMoves(state)) {
    const next = advance(state, move);
    let score = value(next, state.turn);
    if (next.status === "playing") {
      let replyScore = -Infinity;
      for (const reply of getLegalMoves(next)) {
        const after = advance(next, reply);
        const current = value(after, next.turn);
        if (current > replyScore) {
          replyScore = current;
          score = value(after, state.turn);
        }
      }
    }
    if (score > bestScore) {
      best = move;
      bestScore = score;
    }
  }
  return best;
}

test("全根候補の終局予測が公開APIによる独立した応手再現と一致する", () => {
  for (const seed of [1000, 1002]) {
    const state = positionAt("singles", seed, 48);
    if (state.status !== "playing") throw new Error("進行局面が必要です");
    const normal = searchCpuMove(state, { maxWork: 2048 }).move!;
    const forecasts = getLegalMoves(state).map((move) => {
      let current = state as FourReversiState;
      let selected = move;
      while (current.status === "playing") {
        const applied = applyAction(current, { type: "placeStone", position: selected });
        if (!applied.ok) throw new Error("不正な予測手です");
        current = applied.state;
        if (current.status === "playing") selected = referencePolicy(current);
      }
      if (current.result.mode !== "singles") throw new Error("シングルスが必要です");
      const standing = current.result.standings.find((entry) => entry.color === state.turn)!;
      return {
        move,
        rank: standing.rank,
        score: (2 - standing.rank) * 1000000 + (standing.stoneCount ?? 0),
      };
    });
    const best = forecasts.reduce((a, b) => (b.score > a.score ? b : a));
    const normalRank = forecasts.find(
      (entry) => entry.move.x === normal.x && entry.move.y === normal.y,
    )!.rank;
    const result = chooseCpuMoveWithDiagnostics(state);
    expect(result.stats.forecastCompleted).toBe(true);
    expect(result.stats.forecastRoots).toBe(forecasts.length);
    expect(result.stats.exactEndgame).toBe(false);
    expect(result.move).toEqual(best.rank < normalRank ? best.move : normal);
    if (seed === 1002) expect(result.stats.selection).toBe("forecast");
  }
});

test("予測途中の中断はMaxⁿを保持し、総予算と総キャッシュ上限を守る", () => {
  const state = positionAt("singles", 1000, 48);
  const normal = searchCpuMove(state, { maxWork: 2048 });
  const stopped = chooseCpuMoveWithDiagnostics(state, { maxWork: 4096 });
  expect(stopped.stats.forecastCompleted).toBe(false);
  expect(stopped.stats.forecastRoots).toBeGreaterThan(0);
  expect(stopped.stats.forecastRoots).toBeLessThan(stopped.stats.rootMoves);
  expect(stopped.stats.selection).toBe("tree");
  expect(stopped.stats.cutoff).toBe(true);
  expect(stopped.stats.work).toBeLessThanOrEqual(4096);
  expect(stopped.stats.cacheEntries).toBeLessThanOrEqual(2048);
  expect(stopped.move).toEqual(normal.move);
  const cached = chooseCpuMoveWithDiagnostics(state);
  const uncached = chooseCpuMoveWithDiagnostics(state, { cacheLimit: 0 });
  expect(uncached.stats.forecastCompleted).toBe(true);
  expect(uncached.stats.cacheEntries).toBe(0);
  expect(uncached.move).toEqual(cached.move);
});

test("予測の入力は深く不変で、非対象モード・2色・終盤は探索へ委譲する", () => {
  function freeze<T>(value: T): T {
    if (value && typeof value === "object") {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
    return value;
  }
  const state = positionAt("singles", 1001, 48);
  const before = structuredClone(state);
  const selected = chooseCpuMoveWithDiagnostics(freeze(state));
  expect(state).toEqual(before);
  expect(chooseCpuMoveWithDiagnostics(state)).toEqual(selected);
  expect(
    chooseCpuMove(state, 2, () => {
      throw new Error("Lv2が乱数を呼びました");
    }),
  ).toEqual(selected.move);
  for (const input of [
    positionAt("singles", 1000, 48, 2),
    positionAt("doubles", 2000, 48),
    positionAt("singles", 1000, 52),
  ]) {
    const result = chooseCpuMoveWithDiagnostics(input);
    expect(result.stats.forecastRoots).toBe(0);
    expect(result).toEqual(searchCpuMove(input));
  }
  for (const maxWork of [262145, Infinity, Number.MAX_SAFE_INTEGER + 1])
    expect(() =>
      chooseCpuMoveWithDiagnostics(createInitialState("singles"), { maxWork }),
    ).toThrow();
  expect(colors).toHaveLength(4);
});
