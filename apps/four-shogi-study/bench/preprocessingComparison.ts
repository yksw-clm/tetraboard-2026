import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { getCheckState, isInCheck } from "../../../packages/four-shogi/src/board";
import { sides } from "../../../packages/four-shogi/src/types";
import { getLegalMoves, applyLegalMove } from "../../../packages/four-shogi/src/transition";
import {
  chooseCpuAction,
  chooseCpuActionWithDiagnostics,
} from "../../../packages/four-shogi/src/cpu";
import { tacticalCases, acceptsTactic } from "../../../packages/four-shogi/bench/tactics";
import { fixture } from "../../../packages/four-shogi/bench/positionFixture";
import { getAnalysisLegalActions } from "../../../packages/four-shogi/src/analysis";
import { createStudyRootSearch } from "../../../packages/four-shogi/src/studySearch";
import { tacticInput, drainTask } from "./tacticsDiagnostics";
import { fixedRootComparison } from "./tacticsImprovements";
import { restoreStudyPosition } from "../src/domain/study";
import { efficiencySource, efficiencyStrategies } from "./searchEfficiency";
import type { StudyPositionInput } from "../src/shared/model";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export async function comparePreprocessing(options: {
  reference: string;
  inputs: string;
  output: string;
  mode: "semantic" | "speed";
  maxMs: number;
}) {
  const root = resolve(options.reference),
    source = efficiencySource(),
    fingerprint = digest(source),
    started = performance.now();
  const oldBoard = await import(join(root, "packages/four-shogi/src/board.ts"));
  const oldTransition = await import(join(root, "packages/four-shogi/src/transition.ts"));
  const oldCpu = await import(join(root, "packages/four-shogi/src/cpu.ts"));
  const oldSearch = await import(join(root, "packages/four-shogi/src/studySearch.ts"));
  const oldStudy = await import(join(root, "apps/four-shogi-study/src/domain/study.ts"));
  const inputs: { id: string; input: StudyPositionInput }[] = await Bun.file(options.inputs).json();
  const report = {
    source,
    referenceDirectory: root,
    mode: options.mode,
    complete: false,
    failure: null as string | null,
    sourceUnchanged: true,
    rows: [] as any[],
    fixedTactics: [] as any[],
    historicalReplays: 0,
    historicalEvents: 0,
    durationMs: 0,
  };
  const guard = () => {
    if (performance.now() - started > options.maxMs) throw new Error("比較時間の上限です");
  };
  const equal = (a: unknown, b: unknown, label: string) => {
    if (digest(a) !== digest(b)) throw new Error(`差分不一致: ${label}`);
  };
  async function save() {
    report.durationMs = performance.now() - started;
    report.sourceUnchanged = digest(efficiencySource()) === fingerprint;
    await Bun.write(options.output, JSON.stringify(report) + "\n");
  }
  try {
    if (options.mode === "semantic") {
      const cases = [
        ...tacticalCases().map((t) => ({ id: t.id, state: t.state })),
        ...(await Promise.all(
          inputs.map(async (input) => ({
            id: input.id,
            state: (await restoreStudyPosition(input.input)).state,
          })),
        )),
      ];
      for (const mode of ["singles", "doubles"] as const)
        for (const restricted of [false, true])
          for (const remaining of [4, 3, 2])
            cases.push({
              id: `${mode}-${restricted}-${remaining}`,
              state: fixture({
                mode,
                threePlayerAttackProhibited: restricted,
                pieces: [
                  { side: "south", kind: "rook", at: "E5", promoted: true },
                  { side: "north", kind: "silver", at: "D3" },
                ],
                eliminations:
                  remaining === 4
                    ? []
                    : [
                        {
                          side: "west",
                          rank: mode === "singles" ? 4 : null,
                          group: 1,
                          reason: "resigned",
                        },
                        ...(remaining === 2
                          ? [
                              {
                                side: "east" as const,
                                rank: mode === "singles" ? 3 : null,
                                group: 2,
                                reason: "timeout" as const,
                              },
                            ]
                          : []),
                      ],
              }),
            });
      for (const row of cases) {
        guard();
        const before = digest(row.state);
        equal(getCheckState(row.state), oldBoard.getCheckState(row.state), row.id + ":checks");
        for (const side of sides)
          equal(
            isInCheck(row.state, side),
            oldBoard.isInCheck(row.state, side),
            row.id + ":check:" + side,
          );
        const current = getLegalMoves(row.state),
          reference = oldTransition.getLegalMoves(row.state);
        equal(current, reference, row.id + ":ordered legal moves");
        for (let index = 0; index < current.length; index++)
          equal(
            applyLegalMove(row.state, row.state.turn!, current[index]),
            oldTransition.applyLegalMove(row.state, row.state.turn!, reference[index]),
            row.id + ":transition:" + index,
          );
        for (const sample of [0, 0.5, 0.999999])
          equal(
            chooseCpuAction(row.state, 1, () => sample),
            oldCpu.chooseCpuAction(row.state, 1, () => sample),
            row.id + ":Lv1",
          );
        equal(
          chooseCpuActionWithDiagnostics(row.state),
          oldCpu.chooseCpuActionWithDiagnostics(row.state),
          row.id + ":Lv2 action+stats",
        );
        equal(digest(row.state), before, row.id + ":input mutation");
        report.rows.push({
          id: row.id,
          allMatch: true,
          legalMoves: current.length,
          transitions: current.length,
          publicCpu: true,
        });
        await save();
      }
      for (const tactic of tacticalCases().filter((t) => t.family === "inactive-rook")) {
        guard();
        const input = tacticInput(tactic.state),
          position = await restoreStudyPosition(input);
        const legal = getAnalysisLegalActions(position);
        const expected = legal.filter((action) => acceptsTactic(tactic, action));
        const comparison = await fixedRootComparison(
          position,
          [...legal.slice(0, 2), ...expected],
          "dual-continuations",
          9,
          { phase: "deep", width: 2, ownWidth: 3 },
          { deadline: performance.now() + 30000, maxWork: 2_000_000, taskMs: 30000 },
        );
        if (
          !comparison.complete ||
          !comparison.selected ||
          !acceptsTactic(tactic, comparison.selected.action)
        )
          throw new Error("P0-5固定深さの退化: " + tactic.id);
        report.fixedTactics.push({ id: tactic.id, complete: true, accepted: true, comparison });
        await save();
      }
      const history = (
        await Bun.file(resolve("docs/four-shogi-study-p0-refinements-results.jsonl")).text()
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      for (const row of history.filter((row) => row.kind === "match")) {
        guard();
        const current = await restoreStudyPosition({
          origin: { kind: "replay", replay: row.data.replay },
          events: [],
        });
        if (current.stateHash !== row.data.sample.finalStateHash)
          throw new Error("過去棋譜の再生不一致");
        report.historicalReplays++;
        report.historicalEvents += row.data.replay.events.length;
      }
    } else {
      const cases = [
        ...tacticalCases()
          .filter((t) => ["inactive-rook", "poisoned-gold"].includes(t.family))
          .map((t) => ({ id: t.id, input: tacticInput(t.state) })),
        ...[0, 2, 5, 15].map((index) => inputs[index]),
      ];
      for (const row of cases) {
        const positions = [
          await oldStudy.restoreStudyPosition(row.input),
          await restoreStudyPosition(row.input),
        ];
        for (const strategy of efficiencyStrategies)
          for (let repeat = 0; repeat < 3; repeat++) {
            const values: any[] = [];
            for (const variant of repeat % 2 ? [1, 0] : [0, 1]) {
              guard();
              const before = performance.now();
              const factory = variant ? createStudyRootSearch : oldSearch.createStudyRootSearch;
              const search = factory(positions[variant], {
                strategy,
                width: 2,
                extensions: 2,
                cacheSize: 8192,
                dangerWork: 0,
              });
              try {
                if (!drainTask(search, performance.now() + 5000, true).complete)
                  throw new Error("根準備未完了");
                search.startTask(
                  0,
                  4,
                  false,
                  strategy === "adaptive" ? undefined : { phase: "deep", width: 2, ownWidth: 3 },
                );
                if (!drainTask(search, performance.now() + 5000).complete)
                  throw new Error("固定タスク未完了");
                const elapsedMs = performance.now() - before,
                  snapshot = search.snapshot();
                values[variant] = {
                  elapsedMs,
                  work: snapshot.stats.work,
                  nodes: snapshot.stats.nodes,
                  digest: digest({ candidates: snapshot.candidates, stats: snapshot.stats }),
                };
              } finally {
                search.dispose();
              }
            }
            if (values[0].digest !== values[1].digest)
              throw new Error("固定仕事の不一致: " + row.id + ":" + strategy);
            report.rows.push({
              id: row.id,
              strategy,
              repeat,
              reference: values[0],
              optimized: values[1],
              speedRatio: values[0].elapsedMs / values[1].elapsedMs,
              allMatch: true,
            });
            await save();
          }
      }
    }
    report.complete = true;
  } catch (error) {
    report.failure = String(error);
    throw error;
  } finally {
    await save();
  }
  return report;
}
if (import.meta.main) {
  const args = new Map(
    Bun.argv.slice(2).map((arg) => {
      const m = /^--([a-z-]+)=(.+)$/.exec(arg);
      if (!m) throw new Error("--key=value形式です");
      return [m[1], m[2]];
    }),
  );
  const reference = args.get("reference-dir"),
    inputs = args.get("inputs"),
    output = args.get("output");
  if (!reference || !inputs || !output)
    throw new Error("reference-dir/inputs/outputを指定してください");
  const result = await comparePreprocessing({
    reference,
    inputs,
    output,
    mode: args.get("mode") === "speed" ? "speed" : "semantic",
    maxMs: Number(args.get("max-ms") ?? 180000),
  });
  console.log(
    JSON.stringify({
      complete: result.complete,
      rows: result.rows.length,
      fixedTactics: result.fixedTactics.length,
      historicalReplays: result.historicalReplays,
      durationMs: result.durationMs,
    }),
  );
}
