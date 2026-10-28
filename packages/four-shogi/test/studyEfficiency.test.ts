import { expect, test } from "bun:test";
import { createAiContext } from "../src/aiSearchContext";
import { resolveAiOptions } from "../src/ai";
import { createInitialState } from "../src/index";
import { evaluateAiPosition } from "../src/aiEvaluation";
import { restoreAnalysisPosition } from "../src/analysis";
import {
  createStudyRootSearch,
  selectStudyIterationRoots,
  studyBranchKey,
} from "../src/studySearch";
import { applyAction } from "../src/index";

const initial = () =>
  restoreAnalysisPosition({
    schemaVersion: 1,
    rulesVersion: 1,
    ruleProfileId: "tetraboard-four-shogi-singles-v1",
    initial: {
      mode: "singles",
      players: { south: "s", west: "w", north: "n", east: "e" },
      threePlayerAttackProhibited: false,
    },
    events: [],
  });

function finish<T>(steps: Generator<number, T>): T {
  while (true) {
    const next = steps.next();
    if (next.done) return next.value;
  }
}

test("検討用キャッシュは満杯でも新しい局面へ入れ替わる", () => {
  const state = createInitialState({
    mode: "singles",
    players: { south: "s", west: "w", north: "n", east: "e" },
    threePlayerAttackProhibited: false,
  });
  const { settings } = resolveAiOptions({ codeVersion: "cache-test", cacheSize: 2 });
  const ctx = createAiContext(state, settings, undefined, {
    evaluate: evaluateAiPosition,
    replaceCache: true,
  });
  const first = ctx.legal[0].state;
  finish(ctx.evaluate(first));
  finish(ctx.evaluate(ctx.legal[1].state));
  finish(ctx.evaluate(ctx.legal[2].state));
  const before = ctx.stats.evaluations;
  finish(ctx.evaluate(first));
  expect(ctx.stats.evaluations).toBe(before + 1);
  expect(ctx.stats.cacheEntries).toBeLessThanOrEqual(2);
});

test("同じ盤でも反復履歴・攻撃履歴・延長条件が違う枝を再利用しない", async () => {
  const { state } = await initial();
  const key = studyBranchKey(state, 3, 2);
  expect(studyBranchKey(structuredClone(state), 3, 2)).toBe(key);
  expect(
    studyBranchKey({ ...state, repetitions: { ...state.repetitions, other: 1 } }, 3, 2),
  ).not.toBe(key);
  expect(
    studyBranchKey(
      { ...state, recaptureSquares: { ...state.recaptureSquares, south: [{ x: 1, y: 1 }] } },
      3,
      2,
    ),
  ).not.toBe(key);
  expect(studyBranchKey({ ...state, threePlayerAttackProhibited: true }, 3, 2)).not.toBe(key);
  expect(studyBranchKey(state, 2, 2)).not.toBe(key);
  expect(studyBranchKey(state, 3, 1)).not.toBe(key);
});

test("葉の評価を再利用しても内部節点のキャッシュ枠を消費しない", async () => {
  const { state } = await initial();
  const { settings } = resolveAiOptions({ codeVersion: "leaf-cache-test", cacheSize: 2 });
  const ctx = createAiContext(state, settings, undefined, {
    evaluate: evaluateAiPosition,
    replaceCache: true,
    cacheLeafEvaluations: false,
  });
  const leaf = ctx.legal[0].state;
  const first = finish(ctx.evaluate(leaf));
  const before = ctx.stats.evaluations;
  expect(finish(ctx.evaluate(leaf))).toEqual(first);
  expect(ctx.stats.evaluations).toBe(before);
  expect(ctx.stats.cacheEntries).toBe(1);
});

test("完成した根タスクを再利用し、局面に対して合法な読み筋と実手番を保つ", async () => {
  const position = await initial();
  const before = structuredClone(position.state);
  const search = createStudyRootSearch(position, { maxDepth: 4, extensions: 0 });
  try {
    while (search.depth < 1) search.step();
    const index = search.snapshot().candidates[0].rootIndex;
    search.startTask(index, 4);
    while (!search.step()) {}
    const first = search.snapshot();
    search.startTask(index, 4);
    while (!search.step()) {}
    const second = search.snapshot();
    expect(second.performance!.branchCacheHits).toBeGreaterThan(first.performance!.branchCacheHits);
    expect(second.candidates[0].evaluation).toEqual(first.candidates[0].evaluation);
    expect(second.candidates[0].line).toEqual(first.candidates[0].line);
    let state = position.state;
    for (const step of second.candidates[0].line) {
      expect(step.side).toBe(state.turn!);
      const next = applyAction(state, step.side, step.action);
      expect(next.ok).toBe(true);
      if (!next.ok) throw new Error("illegal PV");
      expect(step.nextTurn).toBe(next.state.turn);
      state = next.state;
    }
    expect(position.state).toEqual(before);
  } finally {
    search.dispose();
  }
});

test("深掘りで後回しにした静かな根候補を巡回して再検討する", async () => {
  const search = createStudyRootSearch(await initial(), { maxDepth: 1 });
  try {
    while (!search.step()) {}
    const candidates = search.snapshot().candidates;
    const seen = new Set<number>();
    for (let depth = 2; depth <= 8; depth++)
      selectStudyIterationRoots(candidates, "south", depth, 5).forEach((index) => seen.add(index));
    expect(seen.size).toBe(candidates.length);
  } finally {
    search.dispose();
  }
});
