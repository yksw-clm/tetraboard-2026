import { expect, test } from "bun:test";
import {
  analyzePosition,
  type AiCandidate,
  type AiOptions,
  type AiSearchSettings,
} from "../src/ai";
import {
  restoreAnalysisPosition,
  analysisRuleProfileId,
  getAnalysisLegalActions,
} from "../src/analysis";
import { compareAiValue, evaluateAiPosition } from "../src/aiEvaluation";
import { createAiSearch } from "../src/aiSearch";
import {
  applyAction,
  getActiveSides,
  getCheckState,
  getLegalActions,
  sides,
  type FourShogiState,
} from "../src/index";
import { positionKey } from "../src/repetition";
import { fixture, move, succeeded } from "./helpers";
import { tacticalCases } from "../bench/tactics";
import archive from "../../../test-fixtures/matches/shogi-singles.json";
import drawArchive from "../../../test-fixtures/matches/shogi-singles-draw.json";

const options = {
  codeVersion: "test-code-v1",
  maxWork: 2048,
  maxDepth: 3,
  width: 2,
  rootWidth: 5,
  extensions: 0,
  candidateCount: 5,
} satisfies AiOptions;
function restored(eventOffset = 0, restricted = true) {
  return restoreAnalysisPosition({
    schemaVersion: 1,
    ruleProfileId: analysisRuleProfileId,
    rulesVersion: 1,
    initial: { ...archive.detail.replay.initial, threePlayerAttackProhibited: restricted },
    events: archive.events,
    eventOffset,
  });
}
function replay(state: FourShogiState, candidate: AiCandidate) {
  for (const [index, step] of candidate.line.entries()) {
    expect(step.afterPly).toBe(index + 1);
    expect(state.turn).toBe(step.side);
    const transition = succeeded(applyAction(state, step.side, step.action));
    state = transition.state;
    expect(step.nextTurn).toBe(state.turn);
    expect(step.eliminations).toEqual(transition.eliminations);
    expect(step.captured).toEqual(transition.captured);
    const checks = getCheckState(state);
    expect(step.checkedSides).toEqual(getActiveSides(state).filter((side) => checks[side]));
    expect(step.result).toEqual(state.result);
  }
  if (candidate.evaluation !== null) {
    expect(candidate.line[0]?.action).toEqual(candidate.action);
    expect(candidate.evaluation).toEqual(evaluateAiPosition(state));
  }
  expect(candidate.danger.forced).toBe(false);
  expect(candidate.danger.evidence).toEqual(
    candidate.line.slice(0, candidate.danger.evidence.length),
  );
  return state;
}
function settings(overrides: Partial<AiSearchSettings> = {}): AiSearchSettings {
  return {
    timeBudgetMs: null,
    maxWork: 10000,
    maxDepth: 2,
    width: 200,
    rootWidth: 200,
    extensions: 0,
    candidateCount: 5,
    includeAction: null,
    ...overrides,
  };
}
function runCore(state: FourShogiState, config = settings()) {
  const session = createAiSearch(state, config);
  for (const cost of session.steps) {
    if (session.stats.work + cost > config.maxWork) {
      session.steps.return();
      break;
    }
  }
  return session;
}

test("最小処理量・期限0・開始前取消でも合法な予備手を返し、薄い評価を比較結果にしない", async () => {
  const position = await restored();
  const before = JSON.stringify(position);
  const abort = new AbortController();
  abort.abort();
  const cases = [
    { options: { ...options, maxWork: 1 }, control: {}, reason: "work_limit", status: "limited" },
    {
      options: { ...options, timeBudgetMs: 0 },
      control: {},
      reason: "deadline",
      status: "limited",
    },
    { options, control: { signal: abort.signal }, reason: "cancelled", status: "cancelled" },
  ] as const;
  for (const entry of cases) {
    const result = await analyzePosition(position, entry.options, entry.control);
    expect(result.status).toBe(entry.status);
    expect(result.diagnostics.stopReason).toBe(entry.reason);
    expect(result.diagnostics.work).toBeLessThanOrEqual(entry.options.maxWork);
    expect(result.diagnostics.fallbackReason).toBe("no_completed_iteration");
    expect(getAnalysisLegalActions(position)).toContainEqual(result.recommendedAction!);
    expect(result.evaluation).toBeNull();
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      completedDepth: 0,
      evaluation: null,
      cutoff: true,
      line: [],
    });
  }
  expect(JSON.stringify(position)).toBe(before);
});

test("未完了の反復を混ぜず、完了済みの候補群を処理量・取消・期限から回収する", async () => {
  const position = await restored();
  const complete = await analyzePosition(position, { ...options, maxDepth: 1 }, { now: () => 0 });
  expect(complete.candidates).toHaveLength(5);
  const limited = await analyzePosition(
    position,
    { ...options, maxWork: complete.diagnostics.work + 1 },
    { now: () => 0 },
  );
  expect(limited.diagnostics.stopReason).toBe("work_limit");
  expect(limited.diagnostics.completedDepth).toBe(1);
  expect(limited.candidates.map(({ cutoff: _cutoff, ...rest }) => rest)).toEqual(
    complete.candidates.map(({ cutoff: _cutoff, ...rest }) => rest),
  );
  for (const timeBudgetMs of [500, 30000]) {
    let time = 0;
    const result = await analyzePosition(
      position,
      { ...options, timeBudgetMs },
      {
        now: () => time,
        onProgress: (progress) => {
          if (progress.completedDepth === 1) time = timeBudgetMs;
        },
      },
    );
    expect(result.diagnostics.stopReason).toBe("deadline");
    expect(result.diagnostics.elapsedMs).toBe(timeBudgetMs);
    expect(result.diagnostics.deadlineOverrunMs).toBe(0);
    expect(result.recommendedAction).toEqual(complete.recommendedAction);
    expect(result.diagnostics.completedDepth).toBe(1);
  }
  let cancel = false;
  const cancelled = await analyzePosition(position, options, {
    now: () => 0,
    isCancelled: () => cancel,
    onProgress: (progress) => {
      if (progress.completedDepth === 1) cancel = true;
    },
  });
  expect(cancelled.status).toBe("cancelled");
  expect(cancelled.diagnostics.completedDepth).toBe(1);
  expect(cancelled.recommendedAction).toEqual(complete.recommendedAction);
  let clockReads = 0;
  const preparationOverrun = await analyzePosition(
    position,
    { ...options, timeBudgetMs: 500 },
    { now: () => (++clockReads <= 2 ? 0 : 600) },
  );
  expect(preparationOverrun.diagnostics.stopReason).toBe("deadline");
  expect(preparationOverrun.diagnostics.legalPreparationMs).toBe(600);
  expect(preparationOverrun.diagnostics.deadlineOverrunMs).toBe(100);
  expect(preparationOverrun.diagnostics.completedDepth).toBe(0);
});

test("実際のイベントループへ譲り、ホストからのAbortSignalを計算途中で受け取る", async () => {
  const position = await restored();
  const controller = new AbortController();
  let hostCalls = 0;
  const result = await analyzePosition(
    position,
    { ...options, maxWork: 100000, maxDepth: 20 },
    {
      now: () => 0,
      signal: controller.signal,
      yieldToHost: async () => {
        hostCalls++;
        await new Promise<void>((resolve) =>
          setTimeout(() => {
            controller.abort();
            resolve();
          }, 0),
        );
      },
    },
  );
  expect(hostCalls).toBe(1);
  expect(result.diagnostics.yields).toBe(1);
  expect(result.status).toBe("cancelled");
  expect(result.diagnostics.work).toBeLessThanOrEqual(130);
  expect(getAnalysisLegalActions(position)).toContainEqual(result.recommendedAction!);
  const nativeController = new AbortController();
  let scheduled = false;
  const native = await analyzePosition(
    position,
    { ...options, maxWork: 100000, maxDepth: 20 },
    {
      now: () => 0,
      signal: nativeController.signal,
      onProgress: () => {
        if (!scheduled) {
          scheduled = true;
          setTimeout(() => nativeController.abort(), 0);
        }
      },
    },
  );
  expect(native.status).toBe("cancelled");
  expect(native.diagnostics.yields).toBeGreaterThan(0);
  expect(native.diagnostics.nodes).toBeGreaterThan(0);
});

test("候補の視点を元手番に固定し、ON/OFF・4/3/2人生存の全PVを正本で再生する", async () => {
  let observedSkip = false;
  for (const restricted of [false, true])
    for (const offset of [0, 49, 101, 102]) {
      const position = await restored(offset, restricted);
      const before = JSON.stringify(position);
      const result = await analyzePosition(position, options, { now: () => 0 });
      const root = position.state.turn!;
      expect(result.input).toMatchObject({
        rootSide: root,
        stateHash: position.stateHash,
        eventOffset: offset,
        threePlayerAttackProhibited: restricted,
      });
      expect(result.diagnostics.algorithm).toBe("maxn");
      expect(result.candidates).toHaveLength(5);
      for (const [index, candidate] of result.candidates.entries()) {
        replay(position.state, candidate);
        expect(candidate.completedDepth).toBe(result.diagnostics.completedDepth);
        if (index > 0)
          expect(
            compareAiValue(
              result.candidates[index - 1].evaluation!.values[root],
              candidate.evaluation!.values[root],
            ),
          ).toBeGreaterThanOrEqual(0);
        if (
          candidate.line.some(
            (step) =>
              step.nextTurn !== null && sides[(sides.indexOf(step.side) + 1) % 4] !== step.nextTurn,
          )
        )
          observedSkip = true;
      }
      expect(result.evaluation).toEqual(result.candidates[0].evaluation);
      expect(JSON.stringify(position)).toBe(before);
    }
  expect(observedSkip).toBe(true);
});

test("単独勝ちと同率1位を区別し、順位は主効用が完全に同じ場合だけ比べる", async () => {
  const sole = (await restored(103)).state;
  const soleValues = evaluateAiPosition(sole);
  expect(soleValues.values.north.primary).toBe(1);
  expect(sides.filter((side) => soleValues.values[side].primary === 1)).toEqual(["north"]);
  const drawn = await restoreAnalysisPosition({
    schemaVersion: 1,
    ruleProfileId: analysisRuleProfileId,
    rulesVersion: 1,
    initial: drawArchive.detail.replay.initial,
    events: drawArchive.events,
  });
  const tied = evaluateAiPosition(drawn.state);
  expect(sides.map((side) => tied.values[side].primary)).toEqual([0, 0, 0, 0]);
  expect(tied.probabilities).toBeNull();
  expect(
    compareAiValue(
      { primary: 0.001, secondaryRank: 4, heuristicScore: null },
      { primary: 0, secondaryRank: 1, heuristicScore: null },
    ),
  ).toBeGreaterThan(0);
  expect(
    compareAiValue(
      { primary: 0, secondaryRank: 2, heuristicScore: null },
      { primary: 0, secondaryRank: 3, heuristicScore: null },
    ),
  ).toBeGreaterThan(0);
  const result = await analyzePosition(drawn, options);
  expect(result.status).toBe("terminal");
  expect(result.diagnostics.stopReason).toBe("terminal");
  expect(result.recommendedAction).toBeNull();
  expect(result.candidates).toEqual([]);
  expect(result.evaluation).toEqual(tied);
});

test("二人生存の相手は自身の単独効用を選び、根の評価を最小にする反復引分へ誘導しない", () => {
  const base = fixture({
    eliminations: [
      { side: "north", reason: "left", rank: 4, group: 1 },
      { side: "east", reason: "left", rank: 3, group: 2 },
    ],
  });
  const rootAction = getLegalActions(base)[0];
  const child = succeeded(applyAction(base, "south", rootAction)).state;
  expect(child.turn).toBe("west");
  const reply = getLegalActions(child)[0];
  const repeatedState = succeeded(applyAction(child, "west", reply)).state;
  const state = { ...base, repetitions: { ...base.repetitions, [positionKey(repeatedState)]: 3 } };
  const repeatedChild = succeeded(applyAction(state, "south", rootAction)).state;
  const tied = succeeded(applyAction(repeatedChild, "west", reply)).state;
  expect(tied.result?.reason).toBe("repetition");
  expect(evaluateAiPosition(tied).values.south.primary).toBe(0);
  expect(evaluateAiPosition(tied).values.west.primary).toBe(0);
  const session = runCore(state, settings({ includeAction: rootAction }));
  expect(session.stats.completedDepth).toBe(2);
  const candidate = session.results().comparedAction!;
  expect(candidate.line[1].side).toBe("west");
  const final = replay(state, candidate);
  expect(final.status).toBe("playing");
  expect(candidate.evaluation!.values.west.primary).toBeGreaterThan(0);
  expect(candidate.evaluation!.values.south.primary).toBeGreaterThan(0);
});

test("一手の単独勝利・詰み脱落と王手で飛ぶ実手番を共有遷移から記録する", () => {
  const winning = tacticalCases().find((entry) => entry.id === "last-opponent-false-south")!.state;
  const search = runCore(winning, settings({ maxDepth: 3 }));
  expect(search.doneReason).toBe("sole_win");
  expect(search.results().candidates[0].evaluation!.values.south.primary).toBe(1);
  const final = replay(winning, search.results().candidates[0]);
  expect(final.status).toBe("finished");
  expect(
    search
      .results()
      .candidates[0].line[0].eliminations.some((entry) => entry.reason === "checkmate"),
  ).toBe(true);
  const magic = tacticalCases().find((entry) => entry.id === "magic-recapture-false-south")!.state;
  const specific = move("E5", "C5");
  const result = runCore(magic, settings({ width: 2, rootWidth: 5, includeAction: specific }));
  const candidate = result.results().comparedAction!;
  expect(candidate.line.map((step) => step.side)).toEqual(["south", "east"]);
  expect(candidate.danger.untilNextOwnTurn).toBe("returned");
  replay(magic, candidate);
});

test("合法手なしは終局と別の内部停止理由で返し、候補数は実際の合法手数に収まる", () => {
  const blocked = fixture({
    kings: { south: "E9" },
    pieces: [
      { side: "west", kind: "rook", at: "E1" },
      { side: "south", kind: "pawn", at: "D8" },
      { side: "south", kind: "pawn", at: "F8" },
      { side: "south", kind: "rook", at: "D9" },
      { side: "south", kind: "rook", at: "F9" },
    ],
  });
  expect(getLegalActions(blocked)).toEqual([]);
  const empty = runCore(blocked);
  expect(empty.doneReason).toBe("no_legal_actions");
  expect(empty.results().candidates).toEqual([]);
  // 公開復元経路では合法手なしは正本の自動脱落で解消済みです。
  const two = fixture({
    kings: { south: "A9", west: "C1" },
    pieces: [
      { side: "south", kind: "pawn", at: "B9" },
      { side: "west", kind: "rook", at: "A1" },
    ],
  });
  const legal = getLegalActions(two);
  expect(legal).toHaveLength(1);
  const result = runCore(two, settings({ maxDepth: 1 })).results();
  expect(result.candidates).toHaveLength(Math.min(5, legal.length));
});

test("版・解決済み条件・実モデル不使用を残し、比較指定手と解析識別を分ける", async () => {
  const position = await restored();
  const includeAction = getAnalysisLegalActions(position).at(-1)!;
  const result = await analyzePosition(position, { ...options, includeAction }, { now: () => 0 });
  expect(result.comparedAction?.action).toEqual(includeAction);
  replay(position.state, result.comparedAction!);
  expect(result.model).toEqual({
    requestedModelId: null,
    loadedModelId: null,
    usedModelId: null,
    inferenceCount: 0,
  });
  expect(result.versions.codeVersion).toBe("test-code-v1");
  expect(result.versions.seed).toBeNull();
  expect(result.settings).toMatchObject({
    timeBudgetMs: null,
    maxDepth: 3,
    candidateCount: 5,
    includeAction,
  });
  expect(result.staticEvaluation.probabilities).toBeNull();
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.candidates[0].line)).toBe(true);
  const again = await analyzePosition(position, { ...options, includeAction }, { now: () => 0 });
  expect(again).toEqual(result);
  for (const change of [
    { maxWork: 2049 },
    { timeBudgetMs: 500 },
    { width: 3 },
    { codeVersion: "test-code-v2" },
    { includeAction: null },
  ]) {
    const other = await analyzePosition(
      position,
      { ...options, includeAction, ...change },
      { now: () => 0 },
    );
    expect(other.cacheKey).not.toBe(result.cacheKey);
  }
});

test("呼出し後の設定変更と進捗参照で探索を変更できない", async () => {
  const position = await restored();
  const request = {
    ...options,
    includeAction: structuredClone(getAnalysisLegalActions(position).at(-1)!),
  };
  const original = structuredClone(request);
  let observed = false;
  const pending = analyzePosition(position, request, {
    now: () => 0,
    onProgress: (progress) => {
      observed = true;
      expect(Object.isFrozen(progress)).toBe(true);
      expect(Object.isFrozen(progress.candidates)).toBe(true);
      if (progress.candidates.length)
        expect(Object.isFrozen(progress.candidates[0].action)).toBe(true);
    },
  });
  request.maxDepth = 1;
  (request.includeAction.to as { x: number; y: number }).x = 99;
  const result = await pending;
  expect(observed).toBe(true);
  expect(result.settings.maxDepth).toBe(original.maxDepth);
  expect(result.comparedAction?.action).toEqual(original.includeAction);
});

test("不正条件・非対応モデル・偽局面・非単調時計・非合法な比較手を拒否する", async () => {
  const position = await restored();
  for (const change of [
    { codeVersion: "" },
    { maxWork: 0 },
    { maxDepth: 257 },
    { width: 0 },
    { candidateCount: 1 },
    { candidateCount: 6 },
    { rootWidth: 2 },
    { timeBudgetMs: Infinity },
    { timeBudgetMs: -1 },
    { extensions: 5 },
    { modelId: "not-loaded" },
    { typo: 3 },
  ])
    await expect(
      analyzePosition(position, { ...options, ...change } as AiOptions),
    ).rejects.toThrow();
  await expect(analyzePosition(structuredClone(position), options)).rejects.toThrow(
    "解析APIで復元",
  );
  await expect(
    analyzePosition(position, { ...options, includeAction: move("E5", "E4") }),
  ).rejects.toThrow("合法手");
  let time = 1;
  await expect(analyzePosition(position, options, { now: () => time-- })).rejects.toThrow("時計");
  await expect(analyzePosition(position, options, { now: () => NaN })).rejects.toThrow("時計");
});
