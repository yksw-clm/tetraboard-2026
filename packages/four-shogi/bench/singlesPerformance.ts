import { applyAction, getLegalActions } from "../src/index";
import { evaluatePosition } from "../src/cpuEvaluation";
import { sides, type FourShogiState } from "../src/types";
import { initialPosition, openingPosition, summarizeTimes } from "./measurement";
import { hashJson, type MeasuredSelector } from "./singlesMeasurement";

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
