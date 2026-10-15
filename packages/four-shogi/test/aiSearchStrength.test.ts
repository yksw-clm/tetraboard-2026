import { expect, test } from "bun:test";
import { analyzePosition, resolveAiOptions, type AiCandidate, type AiOptions } from "../src/ai";
import { createAiSearch } from "../src/aiSearch";
import { createAiMcts, chooseUctIndex } from "../src/aiMcts";
import { createAiContext } from "../src/aiSearchContext";
import { probeAiReplies } from "../src/aiTactics";
import { evaluateAiPosition } from "../src/aiEvaluation";
import { positionKey } from "../src/repetition";
import { getCheckState, isInCheck } from "../src/board";
import { getLegalMoves, applyLegalMove } from "../src/transition";
import {
  applyAction,
  getLegalActions,
  getActiveSides,
  sides,
  type FourShogiState,
} from "../src/index";
import { restoreAnalysisPosition, analysisRuleProfileId } from "../src/analysis";
import { tacticalCases, acceptsTactic } from "../bench/tactics";
import { searchTacticalCases } from "../bench/searchTactics";
import { performanceCorpus } from "../bench/singlesPerformance";
import { fixture, move, succeeded } from "./helpers";
import archive from "../../../test-fixtures/matches/shogi-singles.json";

function run(state: FourShogiState, options: Partial<AiOptions> = {}) {
  const settings = resolveAiOptions({
    codeVersion: "test",
    maxDepth: 3,
    maxWork: 100000,
    rootWidth: 5,
    width: 2,
    extensions: 0,
    candidateCount: 5,
    ...options,
  }).settings;
  const session =
    settings.algorithm === "maxn" ? createAiSearch(state, settings) : createAiMcts(state, settings);
  for (const cost of session.steps)
    if (session.stats.work + cost > settings.maxWork) {
      session.steps.return();
      break;
    }
  return session;
}
function replay(state: FourShogiState, line: AiCandidate["line"]) {
  for (const [index, step] of line.entries()) {
    expect(step.side).toBe(state.turn!);
    expect(step.afterPly).toBe(index + 1);
    const next = succeeded(applyAction(state, step.side, step.action));
    expect(step.eliminations).toEqual(next.eliminations);
    expect(step.captured).toEqual(next.captured);
    expect(step.nextTurn).toBe(next.state.turn);
    state = next.state;
  }
  return state;
}
test("駒一覧を共有した王手判定は旧単独判定と一致し、高速遷移も通常遷移を変えない", () => {
  const cases = [
    ...tacticalCases().map((entry) => entry.state),
    ...performanceCorpus().map((entry) => entry.state),
  ];
  for (const state of cases)
    for (const side of sides) expect(getCheckState(state)[side]).toBe(isInCheck(state, side));
  for (const { state } of performanceCorpus()) {
    const before = JSON.stringify(state);
    for (const action of getLegalMoves(state))
      expect(applyLegalMove(state, state.turn!, action)).toEqual(
        succeeded(applyAction(state, state.turn!, action.action)),
      );
    expect(JSON.stringify(state)).toBe(before);
  }
});
test("状態参照のキャッシュと手順序は同じ完成深さの4人値・合法PVを維持する", () => {
  for (const tactic of searchTacticalCases().filter((entry) => entry.state.turn === "south")) {
    const before = JSON.stringify(tactic.state);
    const baseline = run(tactic.state, { cacheSize: 0 });
    for (const moveOrdering of ["tactical", "previous"] as const) {
      const cached = run(tactic.state, { cacheSize: 256, moveOrdering });
      expect(cached.stats.completedDepth).toBe(3);
      expect(
        cached
          .results()
          .candidates.map(({ action, evaluation, line }) => ({ action, evaluation, line })),
      ).toEqual(
        baseline
          .results()
          .candidates.map(({ action, evaluation, line }) => ({ action, evaluation, line })),
      );
      expect(
        cached.stats.legalCacheHits +
          cached.stats.transitionCacheHits +
          cached.stats.evaluationCacheHits,
      ).toBeGreaterThan(0);
      expect(cached.stats.cacheEntries).toBeLessThanOrEqual(256);
      for (const candidate of cached.results().candidates) replay(tactic.state, candidate.line);
    }
    expect(JSON.stringify(tactic.state)).toBe(before);
  }
});
test("調整用の重要戦術は1手延長で一巡の候補比較を完成できる", () => {
  for (const tactic of tacticalCases().filter(
    (entry) => entry.split === "regression" && entry.critical && entry.state.mode === "singles",
  )) {
    const session = run(tactic.state, {
      maxWork: 2048,
      maxDepth: 64,
      width: 6,
      rootWidth: 24,
      extensions: 1,
      cacheSize: 256,
    });
    expect(acceptsTactic(tactic, session.results().candidates[0]?.action ?? null)).toBe(true);
  }
});
test("王手で取り返す人を飛ばし、次の自手番までの全合法応手と連続王手を調べる", () => {
  for (const restricted of [false, true]) {
    const tactic = searchTacticalCases().find(
      (entry) =>
        entry.family === "checking-capture-before-recapture" &&
        entry.state.turn === "south" &&
        entry.state.threePlayerAttackProhibited === restricted,
    )!;
    const settings = resolveAiOptions({
      codeVersion: "test",
      cacheSize: 256,
      dangerPlies: 8,
    }).settings;
    const ctx = createAiContext(tactic.state, settings);
    const generated = ctx.legal.find(
      (entry) => JSON.stringify(entry.action) === JSON.stringify(tactic.action),
    )!;
    const step = ctx.advance(ctx.start, generated, 0);
    let nextStep = step.next();
    while (!nextStep.done) nextStep = step.next();
    const advanced = nextStep.value;
    expect(advanced.state.turn).toBe("north");
    const probe = probeAiReplies(ctx, advanced.state, advanced.step, 10000);
    for (const _cost of probe.steps) {
      /* 小局面の全応手を完了します。 */
    }
    expect(probe.result.complete).toBe(true);
    expect(probe.result.rookLossWitness).toBeNull();
    const north = succeeded(applyAction(advanced.state, "north", move("G1", "H2"))).state;
    expect(north.turn).toBe("east");
    const east = succeeded(applyAction(north, "east", move("D1", "D2"))).state;
    expect(east.turn).toBe("south");
    const second = succeeded(applyAction(east, "south", move("G4", "H4")));
    expect(second.captured).toBeNull();
    expect(second.state.turn).toBe("north");
    expect(getCheckState(second.state).north).toBe(true);
  }
});
test("逆王手と飛車損の別応手を合法な証拠として返し、未完了検査は安全と断定しない", () => {
  for (const tactic of searchTacticalCases().filter(
    (entry) => entry.state.turn === "south" && entry.criterion === "avoid-loss",
  )) {
    const session = run(tactic.state, {
      maxDepth: 1,
      includeAction: tactic.action,
      dangerWork: 4000,
    });
    const candidate = session.results().comparedAction!;
    const witness = candidate.danger.alternatives!.rookLossWitness!;
    expect(witness).not.toBeNull();
    const final = replay(tactic.state, witness);
    expect(witness.at(-1)?.captured).toMatchObject({ side: "south", kind: "rook" });
    if (tactic.family === "counter-check-rook-loss") expect(final.turn).toBe("south");
    const small = run(tactic.state, { maxDepth: 1, includeAction: tactic.action, dangerWork: 1 });
    expect(small.results().comparedAction!.danger.alternatives).toMatchObject({
      complete: false,
      limit: "work_limit",
    });
  }
});
test("読み筋外の即詰みも合法な脱落の証拠として保持する", () => {
  const tactic = tacticalCases().find((entry) => entry.id === "later-enemy-mate-false-south")!;
  const result = run(tactic.state, {
    maxDepth: 1,
    includeAction: move("H5", "F5"),
    dangerWork: 8000,
  });
  const witness = result.results().comparedAction!.danger.alternatives!.eliminationWitness!;
  expect(witness).not.toBeNull();
  const final = replay(tactic.state, witness);
  expect(getActiveSides(final)).not.toContain("south");
  expect(witness.at(-1)?.eliminations).toContainEqual({
    side: "south",
    reason: "checkmate",
    rank: 4,
    group: 1,
  });
});

test("UCTは担当方向の成分で選び、単独効用が異なる場合に副順位へ切り替えない", () => {
  const values = (south: number, west: number, rank = 1) =>
    Object.fromEntries(
      sides.map((side) => [
        side,
        {
          primary: side === "south" ? south : side === "west" ? west : 0,
          secondaryRank: rank,
          heuristicScore: null,
        },
      ]),
    ) as Parameters<typeof chooseUctIndex>[0][number]["values"];
  const entries = [
    { index: 0, visits: 2, values: values(0.1, 0.9, 4) },
    { index: 1, visits: 2, values: values(0.9, 0.1, 1) },
  ];
  expect(chooseUctIndex(entries, "south", 4, 0)).toBe(1);
  expect(chooseUctIndex(entries, "west", 4, 0)).toBe(0);
  expect(
    chooseUctIndex(
      [
        { index: 0, visits: 2, values: values(0, 0) },
        { index: 1, visits: 2, values: values(0.5, 0.5) },
      ],
      "west",
      4,
      0,
    ),
  ).toBe(1);
  expect(
    chooseUctIndex(
      [
        { index: 1, visits: 0, values: values(0.99, 0) },
        { index: 0, visits: 0, values: values(0, 0.99) },
      ],
      "west",
      0,
      1,
    ),
  ).toBe(1);
});
test("多人数MCTSは完成試行だけを公開し、平均評価とPV末尾評価を分ける", async () => {
  for (const restricted of [false, true]) {
    const position = await restoreAnalysisPosition({
      schemaVersion: 1,
      ruleProfileId: analysisRuleProfileId,
      rulesVersion: 1,
      initial: { ...archive.detail.replay.initial, threePlayerAttackProhibited: restricted },
      events: archive.events,
      eventOffset: 49,
    });
    const options = {
      codeVersion: "test",
      algorithm: "mcts" as const,
      cacheSize: 256,
      maxWork: 10000,
      maxDepth: 4,
      rootWidth: 3,
      candidateCount: 3,
      width: 2,
      maxSimulations: 80,
      rolloutPlies: 2,
      seed: 188,
    };
    const result = await analyzePosition(position, options, { now: () => 0 });
    expect(result.versions.seed).toBe(188);
    expect(result.diagnostics.algorithm).toBe("mcts");
    expect(result.diagnostics.stopReason).toBe("simulation_limit");
    expect(result.diagnostics.simulations).toBe(80);
    expect(result.diagnostics.completedDepth).toBe(1);
    expect(result.model.inferenceCount).toBe(0);
    for (const candidate of result.candidates) {
      expect(candidate.comparisonKind).toBe("sample_mean");
      expect(candidate.evaluation!.evaluationKind).toBe("sample_mean");
      expect(candidate.evaluation!.probabilities).toBeNull();
      expect(candidate.visits).toBeGreaterThan(0);
      expect(getLegalActions(position.state)).toContainEqual(candidate.action);
      replay(position.state, candidate.line);
      expect(candidate.lineEvaluation).not.toBeNull();
    }
    expect(await analyzePosition(position, options, { now: () => 0 })).toEqual(result);
    let cancelled = false;
    const interrupted = await analyzePosition(position, options, {
      now: () => 0,
      isCancelled: () => cancelled,
      onProgress: (progress) => {
        if (progress.simulations >= 10) cancelled = true;
      },
    });
    expect(interrupted.status).toBe("cancelled");
    expect(interrupted.diagnostics.simulations).toBeLessThan(80);
    for (const candidate of interrupted.candidates) replay(position.state, candidate.line);
  }
});
test("MCTSでも三人・二人生存と反復履歴を保持し、平均と合法な読み筋を返す", async () => {
  for (const offset of [101, 102]) {
    const position = await restoreAnalysisPosition({
      schemaVersion: 1,
      ruleProfileId: analysisRuleProfileId,
      rulesVersion: 1,
      initial: archive.detail.replay.initial,
      events: archive.events,
      eventOffset: offset,
    });
    const result = await analyzePosition(
      position,
      {
        codeVersion: "test",
        algorithm: "mcts",
        cacheSize: 256,
        maxWork: 5000,
        maxDepth: 2,
        width: 2,
        rootWidth: 3,
        candidateCount: 3,
        maxSimulations: 12,
        rolloutPlies: 0,
      },
      { now: () => 0 },
    );
    for (const candidate of result.candidates) replay(position.state, candidate.line);
    expect(result.input.rootSide).toBe("north");
    for (const side of sides.filter(
      (side) => side === "west" || (offset === 102 && side === "east"),
    ))
      expect(result.staticEvaluation.values[side].primary).toBe(0);
  }
  const base = fixture({
    eliminations: [
      { side: "north", reason: "left", rank: 4, group: 1 },
      { side: "east", reason: "left", rank: 3, group: 2 },
    ],
  });
  const action = getLegalActions(base)[0];
  const child = succeeded(applyAction(base, "south", action)).state;
  const reply = getLegalActions(child)[0];
  const after = succeeded(applyAction(child, "west", reply)).state;
  const state = { ...base, repetitions: { [positionKey(after)]: 3 } };
  const result = run(state, {
    algorithm: "mcts",
    cacheSize: 256,
    maxDepth: 2,
    includeAction: action,
    rootWidth: 5,
    maxSimulations: 80,
    rolloutPlies: 0,
    exploration: 1.4,
  });
  const candidate = result.results().comparedAction!;
  const final = replay(state, candidate.line);
  expect(final.status).toBe("playing");
  expect(candidate.evaluation!.values.west.primary).toBeGreaterThan(0);
});

test("大きな有限係数でも非終局を単独勝ちと同値にせず、非有限な評価を拒否する", () => {
  const state = fixture({ pieces: [{ side: "south", kind: "rook", at: "E5" }] });
  const weights = resolveAiOptions({ codeVersion: "test", evaluationWeights: { mobility: 1e100 } })
    .settings.evaluationWeights;
  const evaluated = evaluateAiPosition(state, weights);
  expect(evaluated.values.south.primary).toBeLessThan(1);
  expect(evaluated.values.south.primary).toBeGreaterThan(0);
  expect(() => evaluateAiPosition(state, { ...weights, mobility: 1e308 })).toThrow("有限数");
});

test("実験方式・キャッシュ・係数・seedを識別し、不正な条件と順位加点を拒否する", async () => {
  const position = await restoreAnalysisPosition({
    schemaVersion: 1,
    ruleProfileId: analysisRuleProfileId,
    rulesVersion: 1,
    initial: archive.detail.replay.initial,
    events: [],
  });
  const options = { codeVersion: "test", maxDepth: 1, maxWork: 1000 };
  const baseline = await analyzePosition(position, options, { now: () => 0 });
  for (const change of [
    { algorithm: "mcts" as const, maxSimulations: 1 },
    { cacheSize: 0 },
    { moveOrdering: "previous" as const },
    { evaluationWeights: { kingRing: 50 } },
  ])
    expect(
      (await analyzePosition(position, { ...options, ...change }, { now: () => 0 })).cacheKey,
    ).not.toBe(baseline.cacheKey);
  for (const change of [
    { algorithm: "unknown" },
    { cacheSize: -1 },
    { cacheSize: 2049 },
    { seed: -1 },
    { rolloutPlies: 33 },
    { maxSimulations: 0 },
    { dangerWork: 1001 },
    { dangerPlies: 17 },
    { exploration: NaN },
    { evaluationWeights: { survival: 1 } },
    { evaluationWeights: { kingRing: -1 } },
  ])
    await expect(
      analyzePosition(position, { ...options, ...change } as AiOptions),
    ).rejects.toThrow();
});
