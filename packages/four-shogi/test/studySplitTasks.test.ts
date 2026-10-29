import { expect, test } from "bun:test";
import { restoreAnalysisPosition, type AnalysisPosition } from "../src/analysis";
import { createStudyRootSearch, type StudySubtreeResult } from "../src/studySearch";
import { applyAction } from "../src/index";
import { createAnalysisSetupPosition } from "../src/analysis";
import { fixture } from "../bench/positionFixture";
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
function create(position: AnalysisPosition) {
  return createStudyRootSearch(position, {
    strategy: "dual-continuations",
    maxDepth: 5,
    extensions: 0,
    width: 2,
    cacheSize: 0,
    dangerWork: 0,
  });
}
function prepare(search: ReturnType<typeof create>) {
  while (search.depth < 1) search.step();
}
test("独立応手を完成するまで根を公開せず、逆順集約でも四人評価とPVとworkを保つ", async () => {
  const position = await initial(),
    serial = create(position),
    owner = create(position),
    helper = create(position);
  try {
    for (const s of [serial, owner, helper]) prepare(s);
    const index = serial.snapshot().candidates[0].rootIndex,
      policy = { phase: "deep" as const, width: 2, ownWidth: 3 };
    serial.startTask(index, 5, false, policy);
    while (!serial.step()) {}
    owner.startTask(index, 5, false, policy, true);
    let plan: ReturnType<typeof owner.takeSplitPlan> = null;
    while (!owner.step()) {
      plan = owner.takeSplitPlan?.() ?? null;
      if (plan) break;
    }
    expect(plan).not.toBeNull();
    if (!plan) throw Error("分割されませんでした");
    expect(owner.snapshot().candidates).toHaveLength(0);
    const results: StudySubtreeResult[] = [];
    for (const task of [...plan.tasks].reverse()) {
      helper.startSubtree(structuredClone(task));
      while (!helper.step()) {}
      results.push(helper.subtreeResult()!);
    }
    expect(() => owner.finishSplitPlan(plan!.planId, results.slice(1))).toThrow();
    expect(() =>
      owner.finishSplitPlan(plan!.planId, [results[0], ...results.slice(0, -1)]),
    ).toThrow();
    expect(owner.snapshot().candidates).toHaveLength(0);
    owner.finishSplitPlan(plan.planId, results);
    while (!owner.step()) {}
    expect(owner.snapshot().candidates).toEqual(serial.snapshot().candidates);
    expect(() => owner.finishSplitPlan(plan!.planId, results)).toThrow();
    for (const candidate of owner.snapshot().candidates) {
      let state = position.state;
      for (const step of candidate.line) {
        expect(step.side).toBe(state.turn!);
        const next = applyAction(state, step.side, step.action);
        expect(next.ok).toBe(true);
        if (!next.ok) throw Error("illegal PV");
        expect(step.nextTurn).toBe(next.state.turn);
        state = next.state;
      }
    }
  } finally {
    for (const s of [serial, owner, helper]) s.dispose();
  }
});

test("同じworkerで複数の根を退避し、自分の子を処理しても仕事を重複計上しない", async () => {
  const position = await initial(),
    owner = create(position),
    serial = create(position);
  try {
    prepare(owner);
    prepare(serial);
    const policy = { phase: "deep" as const, width: 2, ownWidth: 3 },
      indices = owner
        .snapshot()
        .candidates.slice(0, 2)
        .map((c) => c.rootIndex);
    const expected = indices.map((index) => {
      serial.startTask(index, 5, false, policy);
      while (!serial.step()) {}
      return serial.snapshot().candidates;
    });
    const plans = indices.map((index) => {
      owner.startTask(index, 5, false, policy, true);
      while (!owner.step()) {
        const plan = owner.takeSplitPlan();
        if (plan) return plan;
      }
      throw Error("missing plan");
    });
    const completed = new Map<number, StudySubtreeResult[]>();
    for (const plan of [...plans].reverse()) {
      const results = [];
      for (const task of [...plan.tasks].reverse()) {
        owner.startSubtree({ localPlanId: plan.planId, slot: task.slot });
        while (!owner.step()) {}
        results.push(owner.subtreeResult()!);
      }
      completed.set(plan.planId, results);
    }
    for (const [i, plan] of plans.entries()) {
      owner.finishSplitPlan(plan.planId, completed.get(plan.planId)!);
      while (!owner.step()) {}
      expect(owner.snapshot().candidates).toEqual(expected[i]);
    }
    expect(owner.snapshot().stats.work).toBe(serial.snapshot().stats.work);
    expect(owner.snapshot().stats.nodes).toBe(serial.snapshot().stats.nodes);
  } finally {
    owner.dispose();
    serial.dispose();
  }
});

test("別の入力文脈の子を拒否し、破棄した計画を再利用しない", async () => {
  const position = await initial(),
    owner = create(position),
    helper = create(position);
  try {
    prepare(owner);
    prepare(helper);
    owner.startTask(0, 5, false, { phase: "deep", width: 2, ownWidth: 3 }, true);
    let plan: ReturnType<typeof owner.takeSplitPlan> = null;
    while (!owner.step()) {
      plan = owner.takeSplitPlan();
      if (plan) break;
    }
    expect(plan).not.toBeNull();
    if (!plan) throw Error("missing plan");
    expect(() =>
      helper.startSubtree({ ...plan.tasks[0], baseStateHash: "another-position" }),
    ).toThrow();
    expect(() => helper.startSubtree({ ...plan.tasks[0], ply: 1 })).toThrow();
    owner.dispose();
    expect(() =>
      owner.startSubtree({ localPlanId: plan!.planId, slot: plan!.tasks[0].slot }),
    ).toThrow();
    expect(() => owner.finishSplitPlan(plan!.planId, [])).toThrow();
  } finally {
    owner.dispose();
    helper.dispose();
  }
});

for (const restricted of [false, true])
  for (const eliminated of [0, 1, 2])
    test(`手番変更と脱落を含むMaxNの結果を保持する: 禁止${restricted}・生存${4 - eliminated}`, async () => {
      const state = fixture({
        threePlayerAttackProhibited: restricted,
        kings: { south: "A8", east: "C8" },
        pieces: [
          { side: "south", kind: "rook", at: "E3" },
          { side: "west", kind: "gold", at: "C3" },
          { side: "north", kind: "silver", at: "B4" },
        ],
        eliminations:
          eliminated === 0
            ? []
            : eliminated === 1
              ? [{ side: "north", reason: "left", rank: 4, group: 1 }]
              : [
                  { side: "north", reason: "left", rank: 4, group: 1 },
                  { side: "west", reason: "left", rank: 3, group: 2 },
                ],
      });
      const position = await createAnalysisSetupPosition({
        schemaVersion: 1,
        board: state.board.map((row) =>
          row.map((p) => (p ? { side: p.side, kind: p.kind, promoted: p.promoted } : null)),
        ),
        hands: state.hands,
        turn: state.turn!,
        threePlayerAttackProhibited: restricted,
        eliminations: state.eliminations.map((e) => ({
          side: e.side,
          rank: e.rank!,
          group: e.group,
        })),
      });
      const owner = create(position),
        serial = create(position),
        helper = create(position);
      try {
        for (const s of [owner, serial, helper]) prepare(s);
        const candidate = owner.snapshot().candidates.find((c) => c.line[0].nextTurn === "east")!;
        expect(candidate).toBeDefined();
        const policy = { phase: "deep" as const, width: 2, ownWidth: 3 };
        serial.startTask(candidate.rootIndex, 5, false, policy);
        while (!serial.step()) {}
        owner.startTask(candidate.rootIndex, 5, false, policy, true);
        let plan: ReturnType<typeof owner.takeSplitPlan> = null;
        while (!owner.step()) {
          plan = owner.takeSplitPlan();
          if (plan) break;
        }
        expect(plan).not.toBeNull();
        if (!plan) throw Error("missing split");
        const results = [];
        for (const task of plan.tasks) {
          helper.startSubtree(structuredClone(task));
          while (!helper.step()) {}
          results.push(helper.subtreeResult()!);
        }
        owner.finishSplitPlan(plan.planId, results);
        while (!owner.step()) {}
        expect(owner.snapshot().candidates).toEqual(serial.snapshot().candidates);
        expect(Object.keys(owner.snapshot().candidates[0].evaluation!.values)).toHaveLength(4);
      } finally {
        for (const s of [owner, serial, helper]) s.dispose();
      }
    });

test("別workerから戻る同一の完全差分状態を検討内だけで再利用する", async () => {
  const position = await initial(),
    owner = create(position);
  const helper = createStudyRootSearch(position, {
    strategy: "dual-continuations",
    maxDepth: 6,
    extensions: 0,
    cacheSize: 64,
  });
  const fresh = createStudyRootSearch(position, {
    strategy: "dual-continuations",
    maxDepth: 6,
    extensions: 0,
    cacheSize: 64,
  });
  try {
    for (const s of [owner, helper, fresh]) prepare(s);
    owner.startTask(0, 4, false, { phase: "deep", width: 2, ownWidth: 3 }, true);
    let plan: ReturnType<typeof owner.takeSplitPlan> = null;
    while (!owner.step()) {
      plan = owner.takeSplitPlan();
      if (plan) break;
    }
    expect(plan).not.toBeNull();
    if (!plan) throw Error("missing split");
    helper.startSubtree(structuredClone(plan.tasks[0]));
    while (!helper.step()) {}
    const task = { ...structuredClone(plan.tasks[0]), targetDepth: 5, remaining: 3 };
    helper.startSubtree(task);
    while (!helper.step()) {}
    fresh.startSubtree(structuredClone(task));
    while (!fresh.step()) {}
    expect(helper.snapshot().performance?.subtreeStateCacheHits ?? 0).toBeGreaterThan(0);
    expect(helper.subtreeResult()!.branch).toEqual(fresh.subtreeResult()!.branch);
    expect(helper.snapshot().stats.transitionCacheHits).toBeGreaterThan(
      fresh.snapshot().stats.transitionCacheHits,
    );
  } finally {
    for (const s of [owner, helper, fresh]) s.dispose();
  }
});

test("応手状態キャッシュは履歴差を省略せず、容量上限と破棄を守る", async () => {
  const position = await initial(),
    owner = create(position),
    helper = createStudyRootSearch(position, {
      strategy: "dual-continuations",
      maxDepth: 5,
      extensions: 0,
      cacheSize: 1,
    });
  try {
    prepare(owner);
    prepare(helper);
    owner.startTask(0, 4, false, { phase: "deep", width: 2, ownWidth: 3 }, true);
    let plan: ReturnType<typeof owner.takeSplitPlan> = null;
    while (!owner.step()) {
      plan = owner.takeSplitPlan();
      if (plan) break;
    }
    expect(plan).not.toBeNull();
    if (!plan) throw Error("missing split");
    const task = structuredClone(plan.tasks[0]);
    helper.startSubtree(task);
    while (!helper.step()) {}
    const different = {
      ...structuredClone(task),
      state: {
        ...structuredClone(task.state),
        repetitions: { ...task.state.repetitions, anotherHistory: 1 },
      },
    };
    helper.startSubtree(different);
    while (!helper.step()) {}
    expect(helper.snapshot().performance!.subtreeStateCacheHits).toBe(0);
    expect(helper.snapshot().performance!.subtreeStateCacheEntries).toBe(1);
    helper.startSubtree(structuredClone(task));
    while (!helper.step()) {}
    expect(helper.snapshot().performance!.subtreeStateCacheHits).toBe(0);
    helper.dispose();
    expect(helper.snapshot().performance!.subtreeStateCacheEntries).toBe(0);
  } finally {
    owner.dispose();
    helper.dispose();
  }
});
