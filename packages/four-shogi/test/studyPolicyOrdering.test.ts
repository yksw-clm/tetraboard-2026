import { expect, test } from "bun:test";
import { createAnalysisSetupPosition, restoreAnalysisPosition } from "../src/analysis";
import { createStudyRootSearch } from "../src/studySearch";
import type { AiSyncModel } from "../src/aiModel";
import { fixture } from "../bench/positionFixture";

function countingPolicy() {
  let calls = 0;
  const model: AiSyncModel = {
    modelId: "four-shogi-tiny-policy-value-v1:" + "7".repeat(64),
    predict(input) {
      calls++;
      const n = input.legalActionIds.length;
      return {
        id: input.id,
        legalActionIds: input.legalActionIds,
        policyLogits: input.legalActionIds.map((_, i) => i),
        policy: input.legalActionIds.map((_, i) => Number(i === n - 1)),
        topActionId: input.legalActionIds[n - 1],
        value: [0.1, 0.2, 0.3, 0.4, 0],
        illegalPolicyNonzero: 0,
      };
    },
  };
  return { model, calls: () => calls, reset: () => (calls = 0) };
}

test("Policy専用のdeep全応手再評価は使わない推論をせずG0と同じ四人評価とPVを返す", async () => {
  const position = await restoreAnalysisPosition({
    schemaVersion: 1,
    rulesVersion: 1,
    ruleProfileId: "tetraboard-four-shogi-singles-v1",
    initial: {
      mode: "singles",
      players: { south: "s", west: "w", north: "n", east: "e" },
      threePlayerAttackProhibited: true,
    },
    events: [],
  });
  const policy = countingPolicy();
  const options = {
    strategy: "dual-continuations" as const,
    maxDepth: 4,
    cacheSize: 0,
    extensions: 0,
    dangerWork: 0,
  };
  const baseline = createStudyRootSearch(position, options);
  const learned = createStudyRootSearch(position, {
    ...options,
    model: policy.model,
    modelUsage: "policy",
  });
  try {
    for (const search of [baseline, learned]) while (search.depth < 1) search.step();
    expect(policy.calls()).toBeGreaterThan(0);
    policy.reset();
    const index = baseline.snapshot().candidates[0].rootIndex;
    for (const search of [baseline, learned]) {
      search.startTask(index, 4, false, { phase: "deep", width: 2, ownWidth: 3 });
      while (!search.step()) {}
    }
    expect(policy.calls()).toBe(0);
    const semantic = (search: typeof baseline) =>
      search
        .snapshot()
        .candidates.map(({ action, evaluation, line, selective, completedDepth }) => ({
          action,
          evaluation,
          line,
          selective,
          completedDepth,
        }));
    expect(semantic(learned)).toEqual(semantic(baseline));
    expect(learned.snapshot().stats.nodes).toBe(baseline.snapshot().stats.nodes);
  } finally {
    baseline.dispose();
    learned.dispose();
  }
});

test("捕獲後の延長で静かな応手を選ぶときは学習Policyを維持する", async () => {
  const state = fixture({
    pieces: [
      { side: "south", kind: "silver", at: "E5" },
      { side: "west", kind: "rook", at: "F4" },
      { side: "west", kind: "silver", at: "G3" },
    ],
  });
  const position = await createAnalysisSetupPosition({
    schemaVersion: 1,
    board: state.board.map((row) =>
      row.map((p) => (p ? { side: p.side, kind: p.kind, promoted: p.promoted } : null)),
    ),
    hands: state.hands,
    turn: "south",
    threePlayerAttackProhibited: false,
    eliminations: [],
  });
  const policy = countingPolicy();
  const search = createStudyRootSearch(position, {
    strategy: "dual-combined",
    model: policy.model,
    modelUsage: "policy",
    extensions: 2,
    cacheSize: 0,
    dangerWork: 0,
  });
  try {
    while (search.depth < 1) search.step();
    const capture = search.snapshot().candidates.find((c) => c.line[0]?.captured?.kind === "rook")!;
    expect(capture).toBeDefined();
    policy.reset();
    search.startTask(capture.rootIndex, 2, false, { phase: "deep", width: 2, ownWidth: 3 });
    while (!search.step()) {}
    expect(policy.calls()).toBeGreaterThan(0);
    expect(search.snapshot().performance?.modelValueUses ?? 0).toBe(0);
    expect(search.snapshot().candidates[0].line.length).toBeGreaterThan(1);
  } finally {
    search.dispose();
  }
});
