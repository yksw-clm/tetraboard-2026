import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { cpus, release, totalmem, loadavg, freemem } from "node:os";
import { git, repoRoot, sourceIdentity } from "../../../packages/four-shogi/bench/baseline";
import {
  createInitialState,
  applyAction,
  getLegalActions,
  getActiveSides,
} from "../../../packages/four-shogi/src/index";
import {
  createStudySearchRuntime,
  type StudySearchSnapshot,
  type StudySearchOptions,
} from "../src/search/runtime";
import { restoreStudyPosition } from "../src/domain/study";
import { advanceAnalysisPosition } from "../../../packages/four-shogi/src/analysis";
import { getCheckState } from "../../../packages/four-shogi/src/board";
import { explainStudyEvaluation } from "../../../packages/four-shogi/src/studySearch";
import type { StudyPositionInput } from "../src/shared/model";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
export const efficiencyStrategies = [
  "adaptive",
  "dual",
  "dual-continuations",
  "dual-quiescent",
] as const;
export function efficiencySource() {
  return {
    commit: git("rev-parse", "HEAD"),
    dirty: git("status", "--porcelain").length > 0,
    engine: sourceIdentity(resolve(repoRoot, "packages/four-shogi/src")),
    runtime: sourceIdentity(resolve(repoRoot, "apps/four-shogi-study/src/search")),
    bench: sourceIdentity(resolve(repoRoot, "apps/four-shogi-study/bench")),
  };
}
async function save(path: string, value: unknown) {
  await writeFile(path + ".tmp", JSON.stringify(value) + "\n");
  await rename(path + ".tmp", path);
}
export async function prepareEfficiencyInputs(directory: string, seedBase = 9801000) {
  if (!Number.isSafeInteger(seedBase) || seedBase < 0 || seedBase + 3 > 0xffffffff)
    throw new Error("合成入力seedは32bit非負整数の範囲にしてください");
  if (await Bun.file(join(directory, "private-inputs/inputs.json")).exists())
    throw new Error("固定済み入力を上書きしません。新しい測定フォルダを指定してください");
  await mkdir(join(directory, "private-inputs"), { recursive: true });
  const source = (
    await readFile(resolve(repoRoot, "docs/four-shogi-study-p0-refinements-results.jsonl"), "utf8")
  )
    .split("\n")
    .map((line) => (line ? JSON.parse(line) : null))
    .find((row) => row?.kind === "inputFile");
  const inputs: { id: string; input: StudyPositionInput; provenance: string }[] = JSON.parse(
    source.data.text,
  ).map((row: any) => ({ ...row, provenance: "existing-12-private-local-only" }));
  for (let index = 0; index < 4; index++) {
    const restricted = index % 2 === 0,
      seed = seedBase + index;
    let random = seed,
      state = createInitialState({
        mode: "singles",
        players: { south: "s", west: "w", north: "n", east: "e" },
        threePlayerAttackProhibited: restricted,
      });
    const events: any[] = [];
    for (let ply = 0; ply < 24 + index * 24 && state.status === "playing"; ply++) {
      const legal = getLegalActions(state);
      if (!legal.length) break;
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      const action = legal[random % legal.length],
        side = state.turn!;
      const next = applyAction(state, side, action);
      if (!next.ok) throw new Error("生成着手が不正です");
      events.push({ index: events.length, event: { type: "action", side, action } });
      state = next.state;
    }
    if (state.status !== "playing") throw new Error("追加入力が終局しました");
    inputs.push({
      id: `unused-${seed}-${restricted ? "on" : "off"}-ply${events.length}`,
      provenance: "synthetic-unused-seed-no-personal-data",
      input: {
        origin: {
          kind: "replay",
          replay: {
            schemaVersion: 1,
            rulesVersion: 1,
            ruleProfileId: "tetraboard-four-shogi-singles-v1",
            initial: {
              mode: "singles",
              players: { south: "s", west: "w", north: "n", east: "e" },
              threePlayerAttackProhibited: restricted,
            },
            events,
          },
        },
        events: [],
      },
    });
  }
  for (const row of inputs) await restoreStudyPosition(row.input);
  await save(join(directory, "private-inputs/inputs.json"), inputs);
  await save(
    join(directory, "diagnostics/input-manifest.json"),
    inputs.map((row) => ({
      id: row.id,
      provenance: row.provenance,
      sha256: sha(JSON.stringify(row.input)),
    })),
  );
  return inputs;
}
export async function measureEfficiencySearch(
  runtime: ReturnType<typeof createStudySearchRuntime>,
  input: StudyPositionInput,
  options: StudySearchOptions,
) {
  const begin = performance.now();
  let settled = false;
  let resolveDone!: (snapshot: StudySearchSnapshot) => void;
  const done = new Promise<StudySearchSnapshot>((resolve) => {
    resolveDone = resolve;
  });
  const id = await runtime.start(input, options, (snapshot) => {
    if (!["running", "paused"].includes(snapshot.status) && !settled) {
      settled = true;
      resolveDone(snapshot);
    }
  });
  const startedMs = performance.now() - begin;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const snapshot = await Promise.race([
      done,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("探索が応答上限を超えました")),
          (options.timeBudgetMs ?? 1000) + 30000,
        );
      }),
    ]);
    if (snapshot.status === "error" || snapshot.status === "cancelled")
      throw new Error(snapshot.reason ?? snapshot.status);
    return {
      startedMs,
      responseMs: performance.now() - begin,
      snapshot: runtime.get(id) ?? snapshot,
    };
  } finally {
    clearTimeout(timer);
  }
}
export async function verifyEfficiencyRows(
  rows: any[],
  inputs: { id: string; input: StudyPositionInput }[],
) {
  let checked = 0;
  for (const row of rows) {
    const input = inputs.find((input) => input.id === row.id);
    if (!input) throw new Error("入力がありません");
    const position = await restoreStudyPosition(input.input);
    if (position.stateHash !== row.result.snapshot.stateHash)
      throw new Error("局面SHAが一致しません");
    for (const candidate of row.result.snapshot.candidates) {
      let current = position;
      for (const [index, step] of candidate.line.entries()) {
        if (current.state.turn !== step.side || step.afterPly !== index + 1)
          throw new Error("PV手番が一致しません");
        const eliminatedBefore = current.state.eliminations.length;
        current = await advanceAnalysisPosition(current, {
          type: "action",
          side: step.side,
          action: step.action,
        });
        if (current.state.turn !== step.nextTurn) throw new Error("次手番が一致しません");
        const checks = getCheckState(current.state);
        const actual = {
          captured: current.state.lastMove?.captured ?? null,
          eliminations: current.state.eliminations.slice(eliminatedBefore),
          checkedSides: getActiveSides(current.state).filter((side) => checks[side]),
          result: current.state.result,
        };
        const recorded = {
          captured: step.captured,
          eliminations: step.eliminations,
          checkedSides: step.checkedSides,
          result: step.result,
        };
        if (sha(JSON.stringify(actual)) !== sha(JSON.stringify(recorded)))
          throw new Error("PVメタデータが一致しません");
      }
      if (
        sha(JSON.stringify(explainStudyEvaluation(current).evaluation)) !==
        sha(JSON.stringify(candidate.evaluation))
      )
        throw new Error("PV評価が一致しません");
      checked++;
    }
  }
  return { allMatch: true, candidates: checked, searches: rows.length };
}
export async function runEfficiencyMatrix(options: {
  directory: string;
  phase: string;
  maxMinutes: number;
  profile?: boolean;
  limit?: number;
  budgets?: number[];
  reuseWorkers?: boolean;
  reuseChecks?: boolean;
  strategies?: readonly (typeof efficiencyStrategies)[number][];
}) {
  if (
    options.strategies &&
    (!options.strategies.length ||
      new Set(options.strategies).size !== options.strategies.length ||
      options.strategies.some((strategy) => !efficiencyStrategies.includes(strategy)))
  )
    throw new Error("主要4方式から重複なく選んでください");
  const directory = resolve(options.directory),
    source = efficiencySource(),
    fingerprint = sha(JSON.stringify(source)),
    started = performance.now();
  const inputs = (await Bun.file(join(directory, "private-inputs/inputs.json")).json()).slice(
    0,
    options.limit ?? 16,
  ) as Awaited<ReturnType<typeof prepareEfficiencyInputs>>;
  const report = {
    schemaVersion: 1,
    source,
    sourceUnchanged: true,
    phase: options.phase,
    startedAt: new Date().toISOString(),
    endedAt: "",
    complete: false,
    failure: null as string | null,
    environment: {
      bun: Bun.version,
      os: release(),
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      memoryBytes: totalmem(),
    },
    limits: { maxMinutes: options.maxMinutes, workers: 8, memoryMb: 8192 },
    contract: {
      referenceCommit: "336db981a9a7a3575e94d2fd0fc42c7f6bf7c780",
      cold: "new runtime and processes",
      warm: "same runtime after a separate 100ms warm-up; baseline starts fresh processes anyway",
      detailCounters: "latest IPC sample, may omit work after last notification",
      cpu: "process.cpuUsage in search slices, sum is not wall time",
      privateInputs: "retained locally, excluded from upload",
      warmLongIndices: [0, 2, 5, 15],
    },
    options,
    results: [] as any[],
  };
  const file = join(directory, options.phase, "matrix.json");
  await mkdir(join(directory, options.phase), { recursive: true });
  async function keep() {
    report.endedAt = new Date().toISOString();
    report.sourceUnchanged = sha(JSON.stringify(efficiencySource())) === fingerprint;
    await save(file, report);
  }
  try {
    for (const budget of options.budgets ?? [500, 2000, 5000, 20000])
      for (let index = 0; index < inputs.length; index++) {
        if (sha(JSON.stringify(efficiencySource())) !== fingerprint)
          throw new Error("測定ソースが変わりました");
        const input = inputs[index],
          order = efficiencyStrategies
            .map(
              (_, offset) => efficiencyStrategies[(index + offset) % efficiencyStrategies.length],
            )
            .filter((strategy) => !options.strategies || options.strategies.includes(strategy));
        for (const strategy of order)
          for (const thermal of ["cold", "warm"] as const) {
            if (thermal === "warm" && budget > 2000 && ![0, 2, 5, 15].includes(index)) continue;
            if (performance.now() - started >= options.maxMinutes * 60000)
              throw new Error("測定の実時間上限です");
            const threads = budget === 20000 ? 8 : 4;
            const runtime = createStudySearchRuntime({
              threads,
              memoryMb: 8192,
              measureStages: true,
              reuseWorkers: options.reuseWorkers,
              ...(options.profile
                ? {
                    cpuProfileDirectory: join(
                      directory,
                      "profiles",
                      `${options.phase}-${strategy}-${budget}-${index}-${thermal}`,
                    ),
                  }
                : {}),
            });
            const searchOptions = {
              strategy,
              timeBudgetMs: budget,
              reuseChecks: options.reuseChecks,
            };
            try {
              if (thermal === "warm")
                await measureEfficiencySearch(runtime, input.input, {
                  ...searchOptions,
                  timeBudgetMs: 100,
                });
              const result = await measureEfficiencySearch(runtime, input.input, searchOptions);
              report.results.push({
                id: input.id,
                inputSha256: sha(JSON.stringify(input.input)),
                strategy,
                thermal,
                budget,
                threads,
                system: {
                  loadAverage: loadavg(),
                  freeMemoryBytes: freemem(),
                  parentRss: process.memoryUsage.rss(),
                },
                result,
              });
              await keep();
              console.log(
                JSON.stringify({
                  phase: options.phase,
                  count: report.results.length,
                  id: input.id,
                  strategy,
                  thermal,
                  budget,
                  depth: result.snapshot.completedDepth,
                  deepMs: result.snapshot.timing?.deepStartedMs,
                  responseMs: result.responseMs,
                }),
              );
            } finally {
              await runtime.close();
            }
          }
      }
    report.complete = true;
  } catch (error) {
    report.failure = String(error);
    throw error;
  } finally {
    await keep();
  }
  return report;
}
if (import.meta.main) {
  const args = new Map(
    Bun.argv.slice(2).map((arg) => {
      const match = /^--([a-z-]+)=(.+)$/.exec(arg);
      if (!match) throw new Error("--key=value形式で指定してください");
      return [match[1], match[2]];
    }),
  );
  const directory = args.get("directory");
  if (!directory) throw new Error("Git管理外の保存先を指定してください");
  if (args.get("mode") === "prepare")
    console.log(JSON.stringify({ inputs: (await prepareEfficiencyInputs(directory)).length }));
  else if (args.get("mode") === "verify") {
    const report = await Bun.file(
      join(directory, args.get("phase") ?? "baseline", "matrix.json"),
    ).json();
    const result = await verifyEfficiencyRows(
      report.results,
      await Bun.file(join(directory, "private-inputs/inputs.json")).json(),
    );
    await save(join(directory, "validation", `${args.get("phase") ?? "baseline"}-pv.json`), result);
    console.log(JSON.stringify(result));
  } else
    await runEfficiencyMatrix({
      directory,
      phase: args.get("phase") ?? "baseline",
      maxMinutes: Number(args.get("max-minutes") ?? 70),
      limit: args.has("limit") ? Number(args.get("limit")) : undefined,
      budgets: args.get("budgets")?.split(",").map(Number),
      reuseWorkers: args.has("reuse-workers") ? args.get("reuse-workers") === "true" : undefined,
      reuseChecks: args.has("reuse-checks") ? args.get("reuse-checks") === "true" : undefined,
      strategies: args.get("strategies")?.split(",") as
        | (typeof efficiencyStrategies)[number][]
        | undefined,
    });
}
