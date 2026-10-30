import { expect, test } from "bun:test";
import { fixture } from "../../../packages/four-shogi/bench/positionFixture";
import { createStudyRootSearch } from "@tetraboard/four-shogi/study-search";
import { restoreStudyPosition } from "../src/domain/study";
import { tacticInput, drainTask } from "../bench/tacticsDiagnostics";
import { chooseGuardCandidate, runLethalGuard, type GuardRow } from "../src/search/lethalGuard";
import { createGuardedStudySearchRuntime } from "../src/search/guardedRuntime";
import { createStudySearchRuntime } from "../src/search/runtime";
import { parallelTrial } from "../bench/parallelSearch";
import { encodeAction } from "../../../packages/four-shogi/src/actionEncoding";
import { proveFiniteAction } from "../../../packages/four-shogi/src/finiteSurvival";
import { getAnalysisLegalActions } from "@tetraboard/four-shogi/analysis";
import { readLethalGuardEnvironment } from "../src/search/guardSettings";

async function prepared() {
  const input = tacticInput(fixture());
  const position = await restoreStudyPosition(input);
  const search = createStudyRootSearch(position);
  try {
    expect(drainTask(search, performance.now() + 2000, true).complete).toBe(true);
    return { input, position, candidates: search.snapshot().candidates.slice(0, 3) };
  } finally {
    search.dispose();
  }
}

test("ガードは異なる地平の安全/危険を比較しない", async () => {
  const { candidates } = await prepared();
  const rows = candidates.map((candidate, i) => ({
    candidate,
    action: candidate.action,
    actionId: encodeAction(candidate.action),
    maxNRank: i + 1,
    source: "maxn",
    status: i === 0 ? "unsafe" : "safe",
    completedWithinBudget: true,
    proof: {
      action: candidate.action,
      goal: "survival-for-finite-real-plies",
      opponentModel: "all-opponents-adversarial",
      transitions: 0,
      elapsedMs: 0,
      entry: null,
      nodes: {},
      horizon: i === 0 ? 2 : 4,
      root: "south",
      inputHash: "same",
      status: i === 0 ? "unsafe" : "safe",
    },
    witness: null,
  })) as GuardRow[];
  expect(chooseGuardCandidate(candidates, rows, "south")).toBe(candidates[0]);
});

test("unknown・未完成・一本道だけでは変えず、同地平の証明時だけ元順位で代替を選ぶ", async () => {
  const { candidates } = await prepared();
  const rows = candidates.map((candidate, i) => ({
    candidate,
    action: candidate.action,
    actionId: encodeAction(candidate.action),
    maxNRank: i + 1,
    source: "maxn",
    status: i === 0 ? "unsafe" : "safe",
    completedWithinBudget: true,
    proof: {
      action: candidate.action,
      goal: "survival-for-finite-real-plies",
      opponentModel: "all-opponents-adversarial",
      transitions: 0,
      elapsedMs: 0,
      entry: null,
      nodes: {},
      horizon: 4,
      root: "south",
      inputHash: "same",
      status: i === 0 ? "unsafe" : "safe",
    },
    witness: null,
  })) as GuardRow[];
  expect(chooseGuardCandidate(candidates, [rows[0], rows[2], rows[1]], "south")).toBe(
    candidates[1],
  );
  rows[0].status = "unknown";
  rows[0].witness = [candidates[0].action];
  expect(chooseGuardCandidate(candidates, rows, "south")).toBe(candidates[0]);
  rows[0].status = "unsafe";
  rows[0].completedWithinBudget = false;
  expect(chooseGuardCandidate(candidates, rows, "south")).toBe(candidates[0]);
});

test("有限検証の取消・work制限と不正な応手順序を検査する", async () => {
  const { position } = await prepared();
  const action = getAnalysisLegalActions(position)[0];
  const abort = new AbortController();
  abort.abort();
  expect(
    (
      await proveFiniteAction(position, action, "south", 4, {
        maxTransitions: 100,
        maxMs: 100,
        signal: abort.signal,
      })
    ).status,
  ).toBe("unknown");
  expect(
    (
      await proveFiniteAction(position, action, "south", 4, {
        maxTransitions: 100,
        maxMs: 100,
        maxWork: 1,
      })
    ).status,
  ).toBe("unknown");
  await expect(
    proveFiniteAction(position, action, "south", 2, {
      maxTransitions: 100,
      maxMs: 100,
      order: (_p, a) => [a[0], a[0]],
    }),
  ).rejects.toThrow("全合法手");
});

test("OFFとOBSERVEは固定完成探索の候補・評価・PV・work・着手を保持する", async () => {
  const { input, position, candidates } = await prepared();
  const outcomes = [];
  for (const mode of ["legacy-factory", "off", "observe"] as const) {
    const config = { threads: 1, memoryMb: 512, taskPartition: "root" as const };
    const runtime =
      mode === "legacy-factory"
        ? createStudySearchRuntime(config)
        : createGuardedStudySearchRuntime(config, { mode, budgetMs: 40 });
    try {
      const { snapshot } = await parallelTrial(runtime, input, {
        strategy: "dual-continuations",
        timeBudgetMs: 1500,
        maxDepth: 2,
      });
      outcomes.push({
        candidates: snapshot.candidates,
        evaluation: snapshot.evaluation,
        work: snapshot.work,
        nodes: snapshot.nodes,
        action: snapshot.recommendedAction,
        depth: snapshot.completedDepth,
      });
    } finally {
      await runtime.close();
    }
  }
  expect(outcomes[1]).toEqual(outcomes[0]);
  expect(outcomes[2]).toEqual(outcomes[0]);
  const before = structuredClone(candidates);
  const report = await runLethalGuard(position, candidates, [], { mode: "observe", budgetMs: 10 });
  expect(report.changed).toBe(false);
  expect(candidates).toEqual(before);
}, 10000);

test("既定はOFFで、非有限/範囲外の設定を受け付けない", () => {
  expect(readLethalGuardEnvironment({}).mode).toBe("off");
  expect(() => readLethalGuardEnvironment({ STUDY_LETHAL_GUARD_MS: "NaN" })).toThrow();
  expect(() => readLethalGuardEnvironment({ STUDY_LETHAL_GUARD_SELECTION: "all" })).toThrow();
});

test("証明済み単独勝利は有限安全によって覆さない", async () => {
  const { candidates } = await prepared();
  const winner = {
    ...candidates[0],
    evaluation: {
      ...candidates[0].evaluation!,
      evaluationKind: "terminal" as const,
      values: {
        ...candidates[0].evaluation!.values,
        south: { primary: 1, secondaryRank: 1, heuristicScore: null },
      },
    },
  };
  const rows = candidates.map((candidate, i) => ({
    candidate,
    action: candidate.action,
    maxNRank: i + 1,
    source: "maxn",
    proof: null,
    witness: null,
    actionId: encodeAction(candidate.action),
    status: i === 0 ? "unsafe" : "safe",
    completedWithinBudget: true,
  })) as GuardRow[];
  expect(chooseGuardCandidate([winner, ...candidates.slice(1)], rows, "south")).toBe(winner);
});

test("ガード開始直後の取消は遅れて完成結果や変更手を公開しない", async () => {
  const { input } = await prepared();
  const runtime = createGuardedStudySearchRuntime(
    { threads: 1, memoryMb: 512 },
    { mode: "experimental", budgetMs: 100 },
  );
  const states: string[] = [];
  let finish!: () => void;
  const cancelled = new Promise<void>((resolve) => {
    finish = resolve;
  });
  try {
    await runtime.start(input, { timeBudgetMs: 1000, maxDepth: 2 }, (s) => {
      states.push(s.status);
      if (s.status === "running" && s.reason === "lethal_guard") void runtime.cancel(s.id);
      if (s.status === "cancelled") finish();
    });
    await cancelled;
  } finally {
    await runtime.close();
  }
  expect(states).toContain("cancelled");
  expect(states).not.toContain("completed");
}, 5000);
