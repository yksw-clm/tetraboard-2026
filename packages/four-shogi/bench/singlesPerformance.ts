import { applyAction, getLegalActions } from "../src/index";
import { evaluatePosition } from "../src/cpuEvaluation";
import { sides, type FourShogiState } from "../src/types";
import { initialPosition, openingPosition, seededRandom, summarizeTimes } from "./measurement";
import { hashJson, type MeasuredSelector } from "./singlesMeasurement";
import { restoreAnalysisPosition, analysisRuleProfileId } from "../src/analysis";
import { analyzePosition, type AiOptions, type AiResult, type AiCandidate } from "../src/ai";
import type { FourShogiReplayEvent } from "../src/replay";

export function performanceCorpus(restrictions: readonly boolean[] = [false, true]) {
  return restrictions.flatMap((restricted) => {
    const initial = initialPosition("singles", restricted);
    const hands: FourShogiState = {
      ...initial,
      board: initial.board.map((row) =>
        row.map((piece) => (piece?.kind === "king" ? piece : null)),
      ),
      hands: Object.fromEntries(
        sides.map((side) => [side, { rook: 2, gold: 2, silver: 2, pawn: 2 }]),
      ) as FourShogiState["hands"],
      repetitions: {},
    };
    return [
      { name: `${restricted}-initial`, state: initial },
      { name: `${restricted}-hands`, state: hands },
      { name: `${restricted}-opening`, state: openingPosition("singles", restricted, 301) },
    ];
  });
}
export function measurePerformance(
  selector: MeasuredSelector,
  repeats: number,
  restrictions: readonly boolean[] = [false, true],
) {
  if (!Number.isSafeInteger(repeats) || repeats < 1) throw new Error("測定回数は正の整数です");
  const corpus = performanceCorpus(restrictions);
  const timeline: {
    round: number;
    name: string;
    phase: string;
    elapsedMs: number;
    rssBytes: number;
    stats: ReturnType<MeasuredSelector>["stats"];
  }[] = [];
  const operations = corpus.map(({ name, state }) => {
    const action = getLegalActions(state)[0];
    if (!action || state.status !== "playing") throw new Error("性能局面が不正です");
    return {
      name,
      operations: [
        {
          phase: "legalActions",
          run: () => {
            getLegalActions(state);
            return null;
          },
        },
        {
          phase: "publicTransitionIncludingValidation",
          run: () => {
            const result = applyAction(state, state.turn!, action);
            if (!result.ok) throw new Error(result.reason);
            return null;
          },
        },
        {
          phase: "currentStaticEvaluation",
          run: () => {
            evaluatePosition(state);
            return null;
          },
        },
        { phase: "selectedSearchIncludingRulesAndEvaluation", run: () => selector(state).stats },
      ],
    };
  });
  for (const { operations: phases } of operations) for (const operation of phases) operation.run();
  for (let round = 0; round < repeats; round++)
    for (const { name, operations: phases } of operations)
      for (const operation of phases) {
        const before = performance.now();
        const stats = operation.run();
        timeline.push({
          round,
          name,
          phase: operation.phase,
          elapsedMs: performance.now() - before,
          rssBytes: process.memoryUsage().rss,
          stats,
        });
      }
  const measurements = operations.flatMap(({ name, operations: phases }) =>
    phases.map(({ phase }) => {
      const rows = timeline.filter((entry) => entry.name === name && entry.phase === phase);
      return {
        name,
        phase,
        ...summarizeTimes(rows.map((entry) => entry.elapsedMs)),
        maxRssBytes: Math.max(...rows.map((entry) => entry.rssBytes)),
        firstMs: rows[0].elapsedMs,
        lastMs: rows.at(-1)!.elapsedMs,
      };
    }),
  );
  return {
    corpusHash: hashJson(corpus),
    repeats,
    measurements,
    timeline,
    modelEvaluation: { status: "not_implemented", measurements: null },
    ipc: { status: "not_applicable_local", measurements: null },
    queue: { status: "not_applicable_local", measurements: null },
    interpretation:
      "各phaseは独立に再実行した測定です。遷移は合法性検証を含み、探索はルール・評価を含むため時間を加算しません。静的評価は現行コードです。RSSは測定プロセス全体のbytesです。Macの結果はVPS性能保証ではありません。",
  };
}

/** #185と同じ初期・seed301の開始系列を、公開復元/共通AIの入口で測ります。 */
export async function measureAnalysisPerformance(
  options: AiOptions,
  repeats: number,
  restrictions: readonly boolean[] = [false, true],
) {
  if (!Number.isSafeInteger(repeats) || repeats < 1) throw new Error("測定回数は正の整数です");
  const corpus = performanceCorpus(restrictions).filter((entry) => !entry.name.endsWith("-hands"));
  const positions = await Promise.all(
    corpus.map(async ({ name, state }) => {
      const initial = {
        mode: "singles" as const,
        players: state.players,
        threePlayerAttackProhibited: state.threePlayerAttackProhibited,
      };
      let replayState = initialPosition("singles", state.threePlayerAttackProhibited);
      const events: { index: number; event: FourShogiReplayEvent }[] = [];
      const random = seededRandom(301);
      for (let ply = 0; ply < (name.endsWith("-opening") ? 12 : 0); ply++) {
        if (replayState.status !== "playing") throw new Error("開始系列が終局しました");
        const legal = getLegalActions(replayState);
        const action = legal[Math.floor(random() * legal.length)];
        events.push({ index: ply, event: { type: "action", side: replayState.turn, action } });
        const transition = applyAction(replayState, replayState.turn, action);
        if (!transition.ok) throw new Error(transition.reason);
        replayState = transition.state;
      }
      const position = await restoreAnalysisPosition({
        schemaVersion: 1,
        ruleProfileId: analysisRuleProfileId,
        rulesVersion: 1,
        initial,
        events,
      });
      if (hashJson(position.state) !== hashJson(state))
        throw new Error("#185の測定局面と復元が一致しません");
      return { name, position };
    }),
  );
  const timeline: {
    round: number;
    name: string;
    phase: string;
    elapsedMs: number;
    rssBytes: number;
    input: AiResult["input"];
    settings: AiResult["settings"];
    model: AiResult["model"];
    versions: AiResult["versions"];
    diagnostics: AiResult["diagnostics"];
    recommendedAction: AiResult["recommendedAction"];
    candidates: (Pick<
      AiCandidate,
      "action" | "completedDepth" | "iterationNodes" | "iterationWork" | "cutoff" | "selective"
    > & { lineLength: number })[];
  }[] = [];
  for (const { position } of positions) await analyzePosition(position, options);
  for (let round = 0; round < repeats; round++)
    for (const { name, position } of positions) {
      const before = performance.now();
      const result = await analyzePosition(position, options);
      timeline.push({
        round,
        name,
        phase: "commonAnalysisIncludingIdentityRulesEvaluationAndHostYields",
        elapsedMs: performance.now() - before,
        rssBytes: process.memoryUsage().rss,
        input: result.input,
        settings: result.settings,
        model: result.model,
        versions: result.versions,
        diagnostics: result.diagnostics,
        recommendedAction: result.recommendedAction,
        candidates: result.candidates.map((candidate) => ({
          action: candidate.action,
          completedDepth: candidate.completedDepth,
          iterationNodes: candidate.iterationNodes,
          iterationWork: candidate.iterationWork,
          cutoff: candidate.cutoff,
          selective: candidate.selective,
          lineLength: candidate.line.length,
        })),
      });
    }
  return {
    corpusHash: hashJson(corpus),
    repeats,
    timeline,
    measurements: positions.map(({ name }) => {
      const rows = timeline.filter((row) => row.name === name);
      return {
        name,
        ...summarizeTimes(rows.map((row) => row.elapsedMs)),
        maxRssBytes: Math.max(...rows.map((row) => row.rssBytes)),
      };
    }),
    modelEvaluation: { status: "not_implemented", measurements: null },
    ipc: { status: "not_applicable_local", measurements: null },
    queue: { status: "not_applicable_local", measurements: null },
    interpretation:
      "#185の初期/12手開始系列だけを再利用します。手作りの持ち駒局面は公開復元入力に代用しません。hash/ルール/静的評価/ホストへのyieldを含む共通API全体の測定です。Macの値はVPS性能・棋力・厳密な応答時間の保証ではありません。",
  };
}
