import { mkdir, rename } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { cpus, totalmem, release } from "node:os";
import { sides, getActiveSides, type FourShogiAction, type Side } from "@tetraboard/four-shogi";
import {
  advanceAnalysisPosition,
  analysisRuleProfileId,
  getAnalysisLegalActions,
  restoreAnalysisPosition,
  type AnalysisPosition,
  type AnalysisReplayInput,
  type FourShogiReplayEvent,
} from "@tetraboard/four-shogi/analysis";
import {
  compareStudyCandidates,
  createStudyRootSearch,
  selectStudyRootIndices,
  type StudyProfile,
} from "@tetraboard/four-shogi/study-search";
import {
  git,
  loadPlayer,
  repoRoot,
  sourceIdentity,
  type Player,
} from "../../../packages/four-shogi/bench/baseline";
import { seededRandom } from "../../../packages/four-shogi/bench/measurement";
import {
  hashJson,
  resultLabels,
  seatLineup,
  summarizeSingles,
  type SinglesSample,
} from "../../../packages/four-shogi/bench/singlesMeasurement";
import {
  createStudySearchRuntime,
  type StudySearchRuntime,
  type StudySearchSnapshot,
} from "../src/search/runtime";
import type { StudyPositionInput } from "../src/shared/model";

type Budget = { work: number } | { timeMs: number };
export const formalStrengthPlan = Object.freeze({
  id: "local-study-holdout-v1",
  series: 16,
  seats: 4,
  gamesPerProfileAndRule: 64,
  totalGames: 256,
  timeMs: 1000,
  threads: 4,
  memoryMb: 8192,
  maxPlies: 512,
  minimumSoleFirstRate: 0.4,
  minimumIntervalLowerExclusive: 0.25,
  bootstrapReplicates: 1000,
});
export type StrengthOptions = {
  budget: Budget;
  threads: number;
  memoryMb: number;
  seed: number;
  seeds: number;
  restrictions: boolean[];
  seats: Side[];
  profiles: StudyProfile[];
  maxPlies: number;
  output: string;
  positionsFile?: string;
  samplesOnly: boolean;
  formal?: boolean;
};
type Opening = {
  replay: AnalysisReplayInput;
  position: AnalysisPosition;
  seed: number;
  restricted: boolean;
  seriesId: string;
};
type Choice = {
  action: FourShogiAction | null;
  work: number;
  depth: number;
  cutoff: boolean;
  elapsedMs: number;
  reason: string;
  safetyComplete: boolean | null;
};
export type RecordedGame = {
  profile: StudyProfile;
  restricted: boolean;
  sample: SinglesSample;
  replay: AnalysisReplayInput;
  candidateElapsedMs: number[];
  candidateDepths: number[];
  candidateReasons: Record<string, number>;
  interrupted: boolean;
};
type PositionSpec = {
  label: string;
  replay: AnalysisReplayInput;
  eventOffset: number;
  provenance: string;
};

function positionInput(replay: AnalysisReplayInput): StudyPositionInput {
  return { origin: { kind: "replay", replay }, events: [] };
}

/** 固定workは再現性確認用です。同じworkが旧Lv2や異なる評価器の同じ実時間を意味しません。 */
export function fixedWorkChoice(
  position: AnalysisPosition,
  work: number,
  profile: StudyProfile,
): Choice {
  const before = performance.now();
  const session = createStudyRootSearch(position, { profile, maxDepth: 64 });
  let selected = false;
  let done = false;
  try {
    while (!done) {
      const snapshot = session.snapshot();
      if (snapshot.depth >= 1 && !selected) {
        session.setRootIndices(
          selectStudyRootIndices(snapshot.candidates, position.state.turn!, 24),
        );
        selected = true;
      }
      if (snapshot.stats.work >= work) break;
      done = session.step();
    }
    const snapshot = session.snapshot();
    const candidates = [...snapshot.candidates].sort((a, b) =>
      compareStudyCandidates(a, b, position.state.turn!),
    );
    return {
      action: candidates[0]?.action ?? getAnalysisLegalActions(position)[0] ?? null,
      work: snapshot.stats.work,
      depth: snapshot.depth,
      cutoff: !done,
      elapsedMs: performance.now() - before,
      reason: done
        ? "max_depth_or_terminal"
        : snapshot.depth === 0
          ? "fallback_work_limit"
          : "work_limit",
      safetyComplete:
        candidates.length > 0 &&
        candidates.every((candidate) => candidate.study.immediateRepliesComplete),
    };
  } finally {
    session.dispose();
  }
}

async function timedChoice(
  runtime: StudySearchRuntime,
  replay: AnalysisReplayInput,
  timeMs: number,
  profile: StudyProfile,
): Promise<Choice> {
  const before = performance.now();
  const snapshot = await new Promise<StudySearchSnapshot>((resolve, reject) => {
    const watchdog = setTimeout(
      () => reject(new Error("計測中の探索が期限後も終了しません")),
      timeMs + 15000,
    );
    void runtime
      .start(positionInput(replay), { timeBudgetMs: timeMs, profile }, (value) => {
        if (value.status === "error" || value.status === "cancelled") {
          clearTimeout(watchdog);
          reject(new Error(value.reason ?? value.status));
        } else if (value.status === "completed") {
          clearTimeout(watchdog);
          resolve(value);
        }
      })
      .catch((error: unknown) => {
        clearTimeout(watchdog);
        reject(error);
      });
  });
  return {
    action: snapshot.recommendedAction,
    work: snapshot.work,
    depth: snapshot.completedDepth,
    cutoff: snapshot.reason === "deadline",
    elapsedMs: performance.now() - before,
    reason: snapshot.reason ?? "unknown",
    safetyComplete: snapshot.diagnostics.safetyComplete,
  };
}

async function opening(seed: number, restricted: boolean): Promise<Opening> {
  const initial = {
    mode: "singles" as const,
    players: { south: "south", west: "west", north: "north", east: "east" },
    threePlayerAttackProhibited: restricted,
  };
  const events: { index: number; event: FourShogiReplayEvent }[] = [];
  let replay: AnalysisReplayInput = {
    schemaVersion: 1,
    ruleProfileId: analysisRuleProfileId,
    rulesVersion: 1,
    initial,
    events,
  };
  let position = await restoreAnalysisPosition(replay);
  const random = seededRandom(seed);
  for (let index = 0; index < 12; index++) {
    const actions = getAnalysisLegalActions(position);
    const event: FourShogiReplayEvent = {
      type: "action",
      side: position.state.turn!,
      action: actions[Math.floor(random() * actions.length)],
    };
    position = await advanceAnalysisPosition(position, event);
    events.push({ index, event });
  }
  if (position.state.status !== "playing" || getActiveSides(position.state).length !== 4)
    throw new Error("開始系列が12手以内に脱落・終局しました");
  replay = { ...replay, events };
  // ON/OFFと全席は同じ元の乱数系列の反復です。区間推定でも一系列として束ねます。
  return {
    replay,
    position,
    seed,
    restricted,
    seriesId: hashJson({ openingSeed: seed, openingPlies: 12 }),
  };
}

async function play(
  opening: Opening,
  seat: Side,
  profile: StudyProfile,
  options: StrengthOptions,
  opponent: Player,
  runtime: StudySearchRuntime | null,
  stopped: () => boolean,
): Promise<RecordedGame> {
  let position = opening.position;
  const events = [...opening.replay.events];
  const decisions: SinglesSample["decisions"] = [];
  const elapsed: number[] = [];
  const depths: number[] = [];
  const reasons: Record<string, number> = {};
  const candidateId = `${profile}/${hashJson(options.budget).slice(0, 10)}`;
  const lineup = seatLineup(seat, candidateId, Array(3).fill(opponent.id));
  while (position.state.status === "playing" && decisions.length < options.maxPlies && !stopped()) {
    const side = position.state.turn;
    const beforeHash = position.stateHash;
    const before = performance.now();
    let action: FourShogiAction | null;
    let stats: SinglesSample["decisions"][number]["stats"];
    if (side === seat) {
      const replay = { ...opening.replay, events };
      const choice =
        "work" in options.budget
          ? fixedWorkChoice(position, options.budget.work, profile)
          : await timedChoice(runtime!, replay, options.budget.timeMs, profile);
      action = choice.action;
      stats = { work: choice.work, completedDepth: choice.depth, cutoff: choice.cutoff };
      elapsed.push(choice.elapsedMs);
      depths.push(choice.depth);
      reasons[choice.reason] = (reasons[choice.reason] ?? 0) + 1;
    } else {
      const decision = opponent.selector(position.state);
      action = decision.action;
      stats = decision.stats;
    }
    if (!action) throw new Error("AIが合法手を返しませんでした");
    const event: FourShogiReplayEvent = { type: "action", side, action };
    const next = await advanceAnalysisPosition(position, event);
    if (position.stateHash !== beforeHash) throw new Error("AIが入力局面を変更しました");
    position = next;
    events.push({ index: events.length, event });
    decisions.push({
      side,
      playerId: lineup[side],
      elapsedMs: performance.now() - before,
      rssBytes: process.memoryUsage().rss,
      stats,
    });
  }
  const interrupted = stopped();
  const sample: SinglesSample = {
    matchId: hashJson({ start: opening.position.stateHash, seat, profile, budget: options.budget }),
    seriesId: opening.seriesId,
    startKind: "opening",
    seed: opening.seed,
    seat,
    lineup,
    status: position.state.status === "finished" ? "finished" : "unfinished",
    moves: decisions.length,
    ...resultLabels(position.state, seat),
    termination:
      position.state.status === "finished"
        ? position.state.result.reason
        : interrupted
          ? "interrupted"
          : "max_plies",
    eliminations: position.state.eliminations,
    finalStateHash: position.stateHash,
    trajectoryHash: hashJson(events),
    decisions,
  };
  return {
    profile,
    restricted: opening.restricted,
    sample,
    replay: { ...opening.replay, events },
    candidateElapsedMs: elapsed,
    candidateDepths: depths,
    candidateReasons: reasons,
    interrupted,
  };
}

function summary(games: readonly RecordedGame[]) {
  return Object.fromEntries(
    (["study", "baseline"] as const).map((profile) => {
      const matches = games.filter((game) => game.profile === profile);
      return [
        profile,
        matches.length ? summarizeSingles(matches.map((game) => game.sample)) : null,
      ];
    }),
  );
}

export function validateFormalStrengthOptions(options: StrengthOptions) {
  const sameSet = <T>(actual: readonly T[], expected: readonly T[]) =>
    actual.length === expected.length && expected.every((value) => actual.includes(value));
  if (
    !("timeMs" in options.budget) ||
    options.budget.timeMs !== formalStrengthPlan.timeMs ||
    options.seeds !== formalStrengthPlan.series ||
    options.threads !== formalStrengthPlan.threads ||
    options.memoryMb !== formalStrengthPlan.memoryMb ||
    options.maxPlies !== formalStrengthPlan.maxPlies ||
    !sameSet(options.restrictions, [false, true]) ||
    !sameSet(options.seats, sides) ||
    !sameSet(options.profiles, ["study", "baseline"]) ||
    options.samplesOnly ||
    options.positionsFile
  )
    throw new Error(
      "正式測定は16開始系列・4席・ON/OFF・両profile・1秒・4プロセス・8GiB・512手に固定します",
    );
}

export function assessFormalStrength(
  games: readonly Pick<RecordedGame, "profile" | "restricted" | "sample">[],
  sourceUnchanged = true,
) {
  const byRule = [false, true].map((restricted) => {
    const group = games.filter((entry) => entry.restricted === restricted);
    const samples = (profile: StudyProfile) =>
      group.filter((entry) => entry.profile === profile).map((entry) => entry.sample);
    const studySamples = samples("study");
    const baselineSamples = samples("baseline");
    const identity = (sample: SinglesSample) => `${sample.seed}:${sample.seat}`;
    const studyIds = new Set(studySamples.map(identity));
    const baselineIds = new Set(baselineSamples.map(identity));
    const balanced = (values: readonly SinglesSample[]) => {
      const series = new Map<number, Set<Side>>();
      for (const value of values) {
        const seats = series.get(value.seed) ?? new Set<Side>();
        seats.add(value.seat);
        series.set(value.seed, seats);
      }
      return (
        values.length === formalStrengthPlan.gamesPerProfileAndRule &&
        series.size === formalStrengthPlan.series &&
        [...series.values()].every((seats) => seats.size === sides.length)
      );
    };
    const complete =
      balanced(studySamples) &&
      balanced(baselineSamples) &&
      studyIds.size === studySamples.length &&
      baselineIds.size === baselineSamples.length &&
      [...studyIds].every((id) => baselineIds.has(id));
    const study = studySamples.length ? summarizeSingles(studySamples, complete) : null;
    const baseline = baselineSamples.length ? summarizeSingles(baselineSamples, complete) : null;
    const passed =
      complete &&
      study!.soleFirstRate >= formalStrengthPlan.minimumSoleFirstRate &&
      study!.soleFirstInterval95![0] > formalStrengthPlan.minimumIntervalLowerExclusive &&
      study!.soleFirstRate >= baseline!.soleFirstRate;
    return {
      restricted,
      complete,
      study,
      baseline,
      passed,
      comparison:
        "同じ時間・プロセス数で、それぞれ固定Lv2三体へ対戦します。studyの単独率をbaselineと比較します。",
    };
  });
  const complete =
    games.length === formalStrengthPlan.totalGames && byRule.every((entry) => entry.complete);
  return {
    plan: formalStrengthPlan,
    status: !sourceUnchanged
      ? "invalid_source_changed"
      : !complete
        ? "pending"
        : byRule.every((entry) => entry.passed)
          ? "passed"
          : "failed",
    byRule,
  };
}
async function writeReport(path: string, report: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await Bun.write(temporary, `${JSON.stringify(report, null, 2)}\n`);
  await rename(temporary, path);
}

export async function runStrength(options: StrengthOptions) {
  if (options.formal) validateFormalStrengthOptions(options);
  const source = sourceIdentity(resolve(repoRoot, "packages/four-shogi/src"));
  const runtimeSource = sourceIdentity(resolve(import.meta.dir, "../src/search"));
  const runnerSourceHash = hashJson(await Bun.file(import.meta.path).text());
  const sourceUnchanged = () =>
    sourceIdentity(resolve(repoRoot, "packages/four-shogi/src")).sha256 === source.sha256 &&
    sourceIdentity(resolve(import.meta.dir, "../src/search")).sha256 === runtimeSource.sha256 &&
    hashJson(readFileSync(import.meta.path, "utf8")) === runnerSourceHash;
  const opponent = await loadPlayer("frozen");
  const runtime =
    "timeMs" in options.budget
      ? createStudySearchRuntime({ threads: options.threads, memoryMb: options.memoryMb })
      : null;
  const games: RecordedGame[] = [];
  const positions: {
    label: string;
    provenance: string;
    profile: StudyProfile;
    stateHash: string;
    choice: Choice;
    legal: boolean;
    immediatelyEliminated: boolean;
    replyCanEliminate: boolean;
  }[] = [];
  let interrupted = false;
  const stop = () => {
    interrupted = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const startedAt = new Date().toISOString();
  const report = () => ({
    schemaVersion: 1,
    startedAt,
    updatedAt: new Date().toISOString(),
    environment: {
      platform: process.platform,
      architecture: process.arch,
      os: release(),
      cpu: cpus()[0]?.model,
      cpuCount: cpus().length,
      memoryBytes: totalmem(),
      bun: Bun.version,
    },
    code: {
      commit: git("rev-parse", "HEAD"),
      dirty: git("status", "--porcelain").length > 0,
      source,
      runtimeSource,
      runnerSourceHash,
      sourceUnchanged: sourceUnchanged(),
    },
    options,
    opponent: opponent.metadata,
    interpretation:
      "単独1位と同率1位を区別し、手数上限・中断は未終局です。ON/OFFと席替えは同一開始seedの反復です。固定workは等時間比較ではありません。少数測定は棋力保証に使いません。",
    interrupted,
    summary: summary(games),
    formalAssessment: options.formal ? assessFormalStrength(games, sourceUnchanged()) : null,
    games,
    positions,
  });
  try {
    // 採否条件とholdout範囲を、結果が出る前に保存します。
    if (options.formal) {
      if (await Bun.file(options.output).exists())
        throw new Error(
          "正式測定の出力先は新しいファイルを指定してください。既存結果を上書きしません",
        );
      await writeReport(options.output, report());
    }
    if (!options.samplesOnly) {
      for (let offset = 0; offset < options.seeds && !interrupted; offset++) {
        for (const restricted of options.restrictions) {
          if (interrupted) break;
          const start = await opening(options.seed + offset, restricted);
          for (const seat of options.seats) {
            if (interrupted) break;
            const profiles =
              (offset + sides.indexOf(seat)) % 2 === 0
                ? options.profiles
                : [...options.profiles].reverse();
            for (const profile of profiles) {
              if (interrupted) break;
              const game = await play(
                start,
                seat,
                profile,
                options,
                opponent,
                runtime,
                () => interrupted,
              );
              games.push(game);
              await writeReport(options.output, report());
              console.info(
                JSON.stringify({
                  game: games.length,
                  profile,
                  restricted,
                  seed: start.seed,
                  seat,
                  status: game.sample.status,
                  moves: game.sample.moves,
                  soleFirst: game.sample.soleFirst,
                  termination: game.sample.termination,
                }),
              );
            }
          }
        }
      }
    }
    if (options.positionsFile && !interrupted) {
      const specs = (await Bun.file(options.positionsFile).json()) as PositionSpec[];
      if (!Array.isArray(specs) || specs.length > 100)
        throw new Error("局面サンプルは100件以下の配列です");
      for (const spec of specs) {
        if (interrupted) break;
        const replay = { ...spec.replay, eventOffset: spec.eventOffset };
        const position = await restoreAnalysisPosition(replay);
        if (position.state.status !== "playing")
          throw new Error("局面サンプルは対局中にしてください");
        for (const profile of options.profiles) {
          const choice =
            "work" in options.budget
              ? fixedWorkChoice(position, options.budget.work, profile)
              : await timedChoice(runtime!, replay, options.budget.timeMs, profile);
          if (!choice.action) throw new Error("局面サンプルで合法手を返しませんでした");
          const after = await advanceAnalysisPosition(position, {
            type: "action",
            side: position.state.turn,
            action: choice.action,
          });
          const root = position.state.turn;
          let replyCanEliminate = false;
          if (after.state.status === "playing" && after.state.turn !== root)
            for (const action of getAnalysisLegalActions(after)) {
              const response = await advanceAnalysisPosition(after, {
                type: "action",
                side: after.state.turn,
                action,
              });
              if (!getActiveSides(response.state).includes(root)) {
                replyCanEliminate = true;
                break;
              }
            }
          positions.push({
            label: spec.label,
            provenance: spec.provenance,
            profile,
            stateHash: position.stateHash,
            choice,
            legal: true,
            immediatelyEliminated: !getActiveSides(after.state).includes(root),
            replyCanEliminate,
          });
          await writeReport(options.output, report());
          console.info(
            JSON.stringify({
              position: spec.label,
              profile,
              depth: choice.depth,
              work: choice.work,
              elapsedMs: choice.elapsedMs,
              replyCanEliminate,
            }),
          );
        }
      }
    }
    await writeReport(options.output, report());
  } finally {
    await runtime?.close();
    opponent.dispose();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
  return report();
}

export function argumentsFor(args: string[]): StrengthOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index].startsWith("--") || !args[index + 1])
      throw new Error("--名前 値 の形式で指定してください");
    values.set(args[index].slice(2), args[index + 1]);
  }
  const allowed = [
    "work",
    "time-ms",
    "threads",
    "memory-mb",
    "seed",
    "seeds",
    "restrictions",
    "seats",
    "profiles",
    "max-plies",
    "output",
    "positions",
    "samples-only",
    "formal",
  ];
  if (
    [...values.keys()].some((key) => !allowed.includes(key)) ||
    (values.has("work") && values.has("time-ms"))
  )
    throw new Error("未知または競合する測定引数です");
  function integer(name: string, fallback: number, minimum: number, maximum: number) {
    const value = Number(values.get(name) ?? fallback);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
      throw new Error(`${name}は${minimum}〜${maximum}の整数です`);
    return value;
  }
  const restrictions = (values.get("restrictions") ?? "on,off").split(",");
  const seats = (values.get("seats") ?? sides.join(",")).split(",");
  const profiles = (values.get("profiles") ?? "study,baseline").split(",");
  if (
    restrictions.some((value) => !["on", "off"].includes(value)) ||
    seats.some((value) => !sides.includes(value as Side)) ||
    profiles.some((value) => !["study", "baseline"].includes(value)) ||
    [restrictions, seats, profiles].some((items) => new Set(items).size !== items.length) ||
    ["samples-only", "formal"].some(
      (key) => values.has(key) && !["true", "false"].includes(values.get(key)!),
    )
  )
    throw new Error("ルール・席・比較方式が不正です");
  const formal = values.get("formal") === "true";
  const options: StrengthOptions = {
    budget: values.has("work")
      ? { work: integer("work", 8192, 1, 100000000) }
      : { timeMs: integer("time-ms", formal ? formalStrengthPlan.timeMs : 5000, 1, 3600000) },
    threads: integer("threads", 4, 1, 32),
    memoryMb: integer("memory-mb", 8192, 256, 65536),
    seed: integer("seed", formal ? 9410000 : 8360000, 1000000, 0xffffffff - 1000),
    seeds: integer("seeds", formal ? formalStrengthPlan.series : 2, 1, 1000),
    restrictions: restrictions.map((value) => value === "on"),
    seats: seats as Side[],
    profiles: profiles as StudyProfile[],
    maxPlies: integer("max-plies", 512, 1, 4096),
    output: resolve(values.get("output") ?? "/tmp/four-shogi-study-strength.json"),
    positionsFile: values.get("positions"),
    samplesOnly: values.get("samples-only") === "true",
    formal,
  };
  if (formal) validateFormalStrengthOptions(options);
  return options;
}
if (import.meta.main) await runStrength(argumentsFor(process.argv.slice(2)));
