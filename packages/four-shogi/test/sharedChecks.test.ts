import { expect, test } from "bun:test";
import { fixture } from "../bench/positionFixture";
import { createAiContext } from "../src/aiSearchContext";
import { resolveAiOptions } from "../src/ai";
import { evaluateAiPosition } from "../src/aiEvaluation";
import { getCheckState } from "../src/board";

test("探索内の同一状態だけ王手情報を再利用し、別の脱落・モードと混同しない", () => {
  const state = fixture({
    kings: { south: "E5" },
    pieces: [{ side: "north", kind: "rook", at: "E1" }],
  });
  const before = structuredClone(state);
  const settings = resolveAiOptions({ codeVersion: "shared-checks-test" }).settings;
  const ctx = createAiContext(state, settings, undefined, {
    evaluate: (s) => evaluateAiPosition(s, settings.evaluationWeights),
    sharedChecks: true,
    measureDetails: true,
  });
  const first = ctx.checks(state),
    second = ctx.checks(state);
  expect(first).toEqual(second);
  expect(ctx.metrics.checkCalls).toBe(1);
  expect(ctx.metrics.checkCacheHits).toBe(1);
  expect(Reflect.set(first, "south", false)).toBe(false);
  expect(second.south).toBe(true);
  expect(ctx.checks({ ...state, mode: "doubles" }).south).toBe(false);
  expect(
    ctx.checks({
      ...state,
      eliminations: [{ side: "north", rank: 4, group: 1, reason: "resigned" }],
    }).south,
  ).toBe(false);
  expect(ctx.metrics.checkCalls).toBe(3);
  expect(getCheckState(state).south).toBe(true);
  expect(state).toEqual(before);
});
