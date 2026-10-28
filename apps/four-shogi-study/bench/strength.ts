import { mkdir, open, rename, unlink } from "node:fs/promises";
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
  type StudySearchStrategy,
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
import { createStrengthProcessPool, StrengthProcessStoppedError } from "./strengthProcessPool";
import type { StrengthParentFailure } from "./strengthProcessProtocol";

type Budget = { work: number } | { timeMs: number };
export const strengthRunnerVersion = "local-strength-isolated-parents-v4";
export const strengthScheduleVersion = "balanced-pair-shuffle-v1";
export const formalStrengthPlan = Object.freeze({
  id: "local-study-holdout-isolated-parents-v3",
  seed: 9440000,
  concurrency: 2,
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
  concurrency: number;
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
  resume?: boolean;
  searchStrategy?: StudySearchStrategy;
  compareStrategies?: StudySearchStrategy[];
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
  evaluationComputed: boolean;
  principalVariationComputed: boolean;
};
export type RecordedGame = {
  jobId: string;
  searchStrategy?: StudySearchStrategy;
  lane: number;
  profile: StudyProfile;
  restricted: boolean;
  sample: SinglesSample;
  replay: AnalysisReplayInput;
  candidateElapsedMs: number[];
  candidateDepths: number[];
  candidateReasons: Record<string, number>;
  interrupted: boolean;
};
export type StrengthJob = Readonly<{
  id: string;
  searchStrategy?: StudySearchStrategy;
  seed: number;
  restricted: boolean;
  seat: Side;
  profile: StudyProfile;
}>;
type MeasuredPosition = {
  label: string;
  provenance: string;
  profile: StudyProfile;
  stateHash: string;
  choice: Choice;
  legal: boolean;
  immediatelyEliminated: boolean;
  replyCanEliminate: boolean;
};
export type StrengthResumeContract = Readonly<{
  runnerVersion: string;
  scheduleVersion: string;
  code: unknown;
  environment: unknown;
  options: unknown;
  opponent: unknown;
  jobIds: readonly string[];
}>;
type PositionSpec = {
  label: string;
  replay: AnalysisReplayInput;
  eventOffset: number;
  provenance: string;
};

function positionInput(replay: AnalysisReplayInput): StudyPositionInput {
  return { origin: { kind: "replay", replay }, events: [] };
}

/** 唯一の合法手には選択の余地がないため、対局計測だけ探索を省きます。 */
export function forcedLegalChoice(position: AnalysisPosition): Choice | null {
  const before = performance.now();
  const actions = getAnalysisLegalActions(position);
  if (actions.length !== 1) return null;
  return {
    action: actions[0],
    work: 0,
    depth: 0,
    cutoff: false,
    elapsedMs: performance.now() - before,
    reason: "forced_legal_action",
    safetyComplete: null,
    evaluationComputed: false,
    principalVariationComputed: false,
  };
}

/** 両profileを同じ開始条件のペアにし、席や固定slotへの割当ての偏りを避けます。 */
export function createStrengthJobs(options: StrengthOptions): StrengthJob[] {
  const pairs: StrengthJob[][] = [];
  for (let offset = 0; offset < options.seeds; offset++)
    for (const restricted of options.restrictions)
      for (const seat of options.seats)
        pairs.push(
          options.profiles.flatMap((profile) =>
            (options.compareStrategies ?? [options.searchStrategy]).map((searchStrategy) => {
              const identity = {
                runnerVersion: strengthRunnerVersion,
                seed: options.seed + offset,
                restricted,
                seat,
                profile,
                ...(searchStrategy ? { searchStrategy } : {}),
                budget: options.budget,
                threads: options.threads,
                memoryMb: options.memoryMb,
                concurrency: options.concurrency,
                maxPlies: options.maxPlies,
              };
              return {
                id: hashJson(identity),
                seed: options.seed + offset,
                restricted,
                seat,
                profile,
                ...(searchStrategy ? { searchStrategy } : {}),
              };
            }),
          ),
        );
  const random = seededRandom(options.seed ^ 0x6d2b79f5);
  for (let index = pairs.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [pairs[index], pairs[other]] = [pairs[other], pairs[index]];
  }
  const flip = Math.floor(random() * 2);
  return pairs.flatMap((pair, index) => ((index + flip) % 2 === 0 ? pair : [...pair].reverse()));
}

/** 各laneは一度に一局だけを処理し、空いたlaneが固定順の次の仕事を受け取ります。 */
export async function runStrengthQueue(
  jobs: readonly StrengthJob[],
  concurrency: number,
  completed: ReadonlySet<string>,
  execute: (job: StrengthJob, lane: number) => Promise<void>,
  stopped: () => boolean = () => false,
) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 2)
    throw new Error("対局並列数は1〜2です");
  let cursor = 0;
  const failures: unknown[] = [];
  await Promise.all(
    Array.from({ length: concurrency }, async (_, lane) => {
      while (!failures.length && !stopped()) {
        const job = jobs[cursor++];
        if (!job) break;
        if (completed.has(job.id)) continue;
        try {
          await execute(job, lane);
        } catch (error) {
          failures.push(error);
        }
      }
    }),
  );
  if (failures.length) throw failures[0];
}

/** 固定workは再現性確認用です。同じworkが旧Lv2や異なる評価器の同じ実時間を意味しません。 */
export function fixedWorkChoice(
  position: AnalysisPosition,
  work: number,
  profile: StudyProfile,
  strategy?: StudySearchStrategy,
): Choice {
  const forced = forcedLegalChoice(position);
  if (forced) return forced;
  const before = performance.now();
  const session = createStudyRootSearch(position, { profile, maxDepth: 64, strategy });
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
      evaluationComputed: snapshot.depth > 0,
      principalVariationComputed: snapshot.depth > 0,
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
  position: AnalysisPosition,
  strategy?: StudySearchStrategy,
): Promise<Choice> {
  const forced = forcedLegalChoice(position);
  if (forced) return forced;
  const before = performance.now();
  const snapshot = await new Promise<StudySearchSnapshot>((resolve, reject) => {
    const watchdog = setTimeout(
      () => reject(new Error("計測中の探索が期限後も終了しません")),
      timeMs + 15000,
    );
    void runtime
      .start(positionInput(replay), { timeBudgetMs: timeMs, profile, strategy }, (value) => {
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
    evaluationComputed: snapshot.completedDepth > 0,
    principalVariationComputed: snapshot.completedDepth > 0,
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
  job: StrengthJob,
  lane: number,
  options: StrengthOptions,
  opponent: Player,
  runtime: StudySearchRuntime | null,
  stopped: () => boolean,
): Promise<RecordedGame> {
  const { seat, profile } = job;
  let position = opening.position;
  const events = [...opening.replay.events];
  const decisions: SinglesSample["decisions"] = [];
  const elapsed: number[] = [];
  const depths: number[] = [];
  const reasons: Record<string, number> = {};
  const candidateId = `${profile}/${job.searchStrategy ?? options.searchStrategy ?? "adaptive"}/${hashJson(options.budget).slice(0, 10)}`;
  const lineup = seatLineup(seat, candidateId, Array(3).fill(opponent.id));
  while (position.state.status === "playing" && decisions.length < options.maxPlies && !stopped()) {
    const side = position.state.turn;
    const beforeHash = position.stateHash;
    const before = performance.now();
    let action: FourShogiAction | null;
    let stats: SinglesSample["decisions"][number]["stats"];
    if (side === seat) {
      const replay = { ...opening.replay, events };
      let choice: Choice;
      try {
        choice =
          "work" in options.budget
            ? fixedWorkChoice(
                position,
                options.budget.work,
                profile,
                job.searchStrategy ?? options.searchStrategy,
              )
            : await timedChoice(
                runtime!,
                replay,
                options.budget.timeMs,
                profile,
                position,
                job.searchStrategy ?? options.searchStrategy,
              );
      } catch (error) {
        if (stopped()) break;
        throw error;
      }
      if (stopped()) break;
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
    matchId: job.id,
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
    jobId: job.id,
    searchStrategy: job.searchStrategy ?? options.searchStrategy,
    lane,
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

/** 対局親の同一実行内で局面を復元し、別プロセスの解析オブジェクトを流用しません。 */
export function createStrengthGameRunner(
  options: StrengthOptions,
  opponent: Player,
  runtime: StudySearchRuntime | null,
) {
  const openings = new Map<string, Promise<Opening>>();
  return async (job: StrengthJob, lane: number, stopped: () => boolean) => {
    const key = `${job.seed}:${job.restricted}`;
    let start = openings.get(key);
    if (!start) {
      start = opening(job.seed, job.restricted);
      openings.set(key, start);
    }
    return play(await start, job, lane, options, opponent, runtime, stopped);
  };
}

/** 対局親と集計親が、実際に読み込むコードとHEADを同じ単位で照合します。 */
export function strengthCodeIdentity() {
  return {
    commit: git("rev-parse", "HEAD"),
    source: sourceIdentity(resolve(repoRoot, "packages/four-shogi/src")).sha256,
    runtimeSource: sourceIdentity(resolve(import.meta.dir, "../src/search")).sha256,
    domainSource: sourceIdentity(resolve(import.meta.dir, "../src/domain")).sha256,
    measurementSource: sourceIdentity(resolve(repoRoot, "packages/four-shogi/bench")).sha256,
    processSource: strengthProcessSourceIdentity().sha256,
    runnerSourceHash: hashJson(readFileSync(import.meta.path, "utf8")),
  };
}

export function strengthProcessSourceIdentity() {
  const files = [
    "strength.ts",
    "strengthGameWorker.ts",
    "strengthProcessPool.ts",
    "strengthProcessProtocol.ts",
  ].map((path) => ({
    path,
    sha256: new Bun.CryptoHasher("sha256")
      .update(readFileSync(resolve(import.meta.dir, path)))
      .digest("hex"),
  }));
  return { sha256: hashJson(files), files };
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
    options.concurrency !== formalStrengthPlan.concurrency ||
    options.seed !== formalStrengthPlan.seed ||
    options.maxPlies !== formalStrengthPlan.maxPlies ||
    !sameSet(options.restrictions, [false, true]) ||
    !sameSet(options.seats, sides) ||
    !sameSet(options.profiles, ["study", "baseline"]) ||
    options.samplesOnly ||
    options.positionsFile
  )
    throw new Error(
      "正式測定はseed9440000から16系列・4席・ON/OFF・両profile・各局1秒/4探索プロセス/8GiB・独立親2局並列・512手に固定します",
    );
}

export function assessFormalStrength(
  games: readonly Pick<RecordedGame, "profile" | "restricted" | "sample">[],
  sourceUnchanged = true,
  execution = { interrupted: false, failure: null as string | null, unresolvedWorkerFailures: 0 },
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
        Array.from(
          { length: formalStrengthPlan.series },
          (_, index) => formalStrengthPlan.seed + index,
        ).every((seed) => series.has(seed)) &&
        [...series.values()].every((seats) => seats.size === sides.length)
      );
    };
    const complete =
      balanced(studySamples) &&
      balanced(baselineSamples) &&
      !group.some((entry) => entry.sample.termination === "interrupted") &&
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
      : execution.failure || execution.unresolvedWorkerFailures > 0
        ? "invalid_execution"
        : !complete
          ? "pending"
          : execution.interrupted
            ? "pending"
            : byRule.every((entry) => entry.passed)
              ? "passed"
              : "failed",
    byRule,
    execution,
  };
}
export function strengthRecordsHash(
  games: readonly RecordedGame[],
  attempts: readonly RecordedGame[],
  positions: readonly unknown[],
  workerFailures: readonly StrengthParentFailure[] = [],
  invalidatedGames: readonly RecordedGame[] = [],
) {
  return hashJson({ games, attempts, positions, workerFailures, invalidatedGames });
}

/** 衝突した結果を隔離し、以前失敗したjobが再完了した場合だけ障害履歴を解決済みにします。 */
export function resolveStrengthExecution(input: {
  games: readonly RecordedGame[];
  invalidatedGames: readonly RecordedGame[];
  workerFailures: readonly StrengthParentFailure[];
  currentWorkerFailures: readonly StrengthParentFailure[];
  sourceUnchanged: boolean;
  failure: string | null;
}) {
  const invalidIds = new Set(
    input.currentWorkerFailures
      .filter((entry) => entry.kind === "result_conflict")
      .map((entry) => entry.jobId),
  );
  const games = input.games.filter((game) => !invalidIds.has(game.jobId));
  const completedIds = new Set(games.map((game) => game.jobId));
  const workerFailures = [
    ...input.workerFailures.map((entry) => ({
      ...entry,
      resolved:
        entry.resolved ||
        (input.failure === null &&
          input.sourceUnchanged &&
          entry.jobId !== null &&
          completedIds.has(entry.jobId)),
    })),
    ...input.currentWorkerFailures,
  ];
  return {
    games,
    workerFailures,
    invalidatedGames: [
      ...input.invalidatedGames,
      ...input.games.filter((game) => invalidIds.has(game.jobId)),
    ],
    unresolvedWorkerFailures: workerFailures.filter((entry) => !entry.resolved).length,
    failure: input.failure ?? input.currentWorkerFailures.at(-1)?.message ?? null,
  };
}

/** 再開は同じ実行条件・コード・環境と、一意な完了jobだけを受け入れます。 */
export function validateStrengthResume(
  input: unknown,
  contract: StrengthResumeContract,
  jobs: readonly StrengthJob[],
): {
  games: RecordedGame[];
  attempts: RecordedGame[];
  positions: MeasuredPosition[];
  startedAt: string;
  resumeCount: number;
  workerFailures: StrengthParentFailure[];
  invalidatedGames: RecordedGame[];
} {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("再開する測定記録が不正です");
  const saved = input as Record<string, unknown>;
  if (
    saved.schemaVersion !== 3 ||
    saved.runnerVersion !== strengthRunnerVersion ||
    !saved.code ||
    typeof saved.code !== "object" ||
    !("sourceUnchanged" in saved.code) ||
    saved.code.sourceUnchanged !== true ||
    saved.contractHash !== hashJson(contract) ||
    hashJson(saved.contract) !== hashJson(contract)
  )
    throw new Error("再開する測定のコード・環境・設定・seed・並列方式が一致しません");
  if (
    !Array.isArray(saved.games) ||
    !Array.isArray(saved.attempts) ||
    !Array.isArray(saved.positions) ||
    !Array.isArray(saved.workerFailures) ||
    !Array.isArray(saved.invalidatedGames) ||
    typeof saved.startedAt !== "string" ||
    !Number.isFinite(Date.parse(saved.startedAt)) ||
    !Number.isSafeInteger(saved.resumeCount) ||
    (saved.resumeCount as number) < 0
  )
    throw new Error("再開する測定の保存形式が不正です");
  const games = saved.games as RecordedGame[];
  const attempts = saved.attempts as RecordedGame[];
  const workerFailures = saved.workerFailures as StrengthParentFailure[];
  const invalidatedGames = saved.invalidatedGames as RecordedGame[];
  if (
    saved.recordsHash !==
    strengthRecordsHash(games, attempts, saved.positions, workerFailures, invalidatedGames)
  )
    throw new Error("再開する測定結果のハッシュが一致しません");
  const expected = new Map(jobs.map((job) => [job.id, job]));
  const seen = new Set<string>();
  if (
    workerFailures.some(
      (entry) =>
        !entry ||
        !["worker_exit", "protocol", "result_conflict", "cleanup"].includes(entry.kind) ||
        typeof entry.resolved !== "boolean" ||
        typeof entry.message !== "string" ||
        !Number.isSafeInteger(entry.lane) ||
        entry.lane < 0 ||
        entry.lane >= 2 ||
        (entry.jobId !== null && !expected.has(entry.jobId)),
    )
  )
    throw new Error("再開する対局親の障害記録が不正です");
  for (const game of [...games, ...attempts, ...invalidatedGames]) {
    const job = expected.get(game?.jobId);
    if (
      !job ||
      game.profile !== job.profile ||
      game.searchStrategy !== job.searchStrategy ||
      game.restricted !== job.restricted ||
      game.sample?.matchId !== job.id ||
      game.sample.seed !== job.seed ||
      game.sample.seat !== job.seat ||
      !Number.isSafeInteger(game.lane) ||
      game.lane < 0 ||
      game.lane >= 2 ||
      !game.replay ||
      game.replay.initial.threePlayerAttackProhibited !== job.restricted
    )
      throw new Error("再開する対局のjob ID・seed・席・profileが一致しません");
  }
  const unresolvedConflicts = new Set(
    workerFailures
      .filter((entry) => entry.kind === "result_conflict" && !entry.resolved)
      .map((entry) => entry.jobId),
  );
  for (const game of games) {
    if (
      game.interrupted ||
      game.sample.termination === "interrupted" ||
      seen.has(game.jobId) ||
      unresolvedConflicts.has(game.jobId)
    )
      throw new Error("再開する完了対局に中断・重複・未解決の結果衝突があります");
    seen.add(game.jobId);
  }
  if (attempts.some((game) => !game.interrupted))
    throw new Error("再開する中断記録の区分が不正です");
  return {
    games,
    attempts,
    positions: saved.positions as MeasuredPosition[],
    startedAt: saved.startedAt,
    resumeCount: (saved.resumeCount as number) + 1,
    workerFailures,
    invalidatedGames,
  };
}

async function writeReport(path: string, contents: string, exclusive = false) {
  await mkdir(dirname(path), { recursive: true });
  if (exclusive) {
    const file = await open(path, "wx", 0o600);
    try {
      await file.writeFile(contents, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    return;
  }
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await Bun.write(temporary, contents);
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    });
  }
}

/** 2laneの完了が重なっても、呼出し時点の記録を保存順に確定します。 */
export function createStrengthReportWriter(path: string) {
  let queue = Promise.resolve();
  return {
    write(report: unknown, exclusive = false) {
      const contents = `${JSON.stringify(report, null, 2)}\n`;
      const operation = queue.then(() => writeReport(path, contents, exclusive));
      queue = operation.catch(() => {});
      return operation;
    },
    idle() {
      return queue;
    },
  };
}

export async function runStrength(options: StrengthOptions) {
  if (options.formal) validateFormalStrengthOptions(options);
  if (options.resume && (options.samplesOnly || options.positionsFile))
    throw new Error("resumeは対局測定だけに指定できます");
  const existing = await Bun.file(options.output).exists();
  if (existing && !options.resume)
    throw new Error("測定の出力先は新しいファイルを指定してください。既存結果を上書きしません");
  if (!existing && options.resume) throw new Error("再開する測定記録がありません");
  const source = sourceIdentity(resolve(repoRoot, "packages/four-shogi/src"));
  const runtimeSource = sourceIdentity(resolve(import.meta.dir, "../src/search"));
  const domainSource = sourceIdentity(resolve(import.meta.dir, "../src/domain"));
  const measurementSource = sourceIdentity(resolve(repoRoot, "packages/four-shogi/bench"));
  const processSource = strengthProcessSourceIdentity();
  const runnerSourceHash = hashJson(await Bun.file(import.meta.path).text());
  const commit = git("rev-parse", "HEAD");
  const dirty = git("status", "--porcelain").length > 0;
  const codeIdentity = strengthCodeIdentity();
  const sourceUnchanged = () => hashJson(strengthCodeIdentity()) === hashJson(codeIdentity);
  const opponent = await loadPlayer("frozen");
  let pool: ReturnType<typeof createStrengthProcessPool> | null = null;
  let sampleRuntime: StudySearchRuntime | null = null;
  let startedMeasurements = false;
  const workerFailures: StrengthParentFailure[] = [];
  const invalidatedGames: RecordedGame[] = [];
  const games: RecordedGame[] = [];
  const attempts: RecordedGame[] = [];
  const positions: MeasuredPosition[] = [];
  const jobs = options.samplesOnly ? [] : createStrengthJobs(options);
  const environment = {
    platform: process.platform,
    architecture: process.arch,
    os: release(),
    cpu: cpus()[0]?.model,
    cpuCount: cpus().length,
    memoryBytes: totalmem(),
    bun: Bun.version,
  };
  const contract: StrengthResumeContract = {
    runnerVersion: strengthRunnerVersion,
    scheduleVersion: strengthScheduleVersion,
    code: codeIdentity,
    environment,
    options: {
      budget: options.budget,
      threads: options.threads,
      memoryMb: options.memoryMb,
      concurrency: options.concurrency,
      seed: options.seed,
      seeds: options.seeds,
      restrictions: options.restrictions,
      seats: options.seats,
      profiles: options.profiles,
      searchStrategy: options.searchStrategy ?? "adaptive",
      compareStrategies: options.compareStrategies ?? null,
      maxPlies: options.maxPlies,
      positionsFile: options.positionsFile ?? null,
      samplesOnly: options.samplesOnly,
      formal: options.formal ?? false,
      topology: "coordinator-and-independent-game-parents",
    },
    opponent: opponent.metadata,
    jobIds: jobs.map((job) => job.id),
  };
  let interrupted = false;
  let failure: string | null = null;
  let startedAt = new Date().toISOString();
  let resumeCount = 0;
  const writer = createStrengthReportWriter(options.output);
  const activeJobs: (string | null)[] = Array(options.concurrency).fill(null);
  const stop = () => {
    interrupted = true;
    pool?.stop();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const report = () => {
    const unchanged = sourceUnchanged();
    const execution = resolveStrengthExecution({
      games,
      invalidatedGames,
      workerFailures,
      currentWorkerFailures: pool?.failures() ?? [],
      sourceUnchanged: unchanged,
      failure,
    });
    const completed = execution.games;
    const incomplete = [...attempts];
    const measuredPositions = [...positions];
    const observedFailures = execution.workerFailures;
    const isolated = execution.invalidatedGames;
    const unresolvedWorkerFailures = execution.unresolvedWorkerFailures;
    const effectiveFailure = execution.failure;
    return {
      schemaVersion: 3,
      runnerVersion: strengthRunnerVersion,
      startedAt,
      updatedAt: new Date().toISOString(),
      resumeCount,
      environment,
      code: {
        commit,
        dirty,
        source,
        runtimeSource,
        domainSource,
        measurementSource,
        processSource,
        runnerSourceHash,
        sourceUnchanged: unchanged,
      },
      contract,
      contractHash: hashJson(contract),
      options,
      opponent: opponent.metadata,
      execution: {
        concurrency: options.concurrency,
        gameParents: options.concurrency,
        maximumTotalProcesses: 1 + options.concurrency * (1 + options.threads),
        scheduler: strengthScheduleVersion,
        maximumSearchProcesses: options.concurrency * options.threads,
        maximumSearchMemoryMb: options.concurrency * options.memoryMb,
        perGame: { threads: options.threads, memoryMb: options.memoryMb, budget: options.budget },
        plannedJobs: jobs.length,
        completedJobs: completed.length,
        activeJobIds: [...activeJobs],
        laneProfiles: Array.from({ length: options.concurrency }, (_, lane) => ({
          lane,
          study: completed.filter((game) => game.lane === lane && game.profile === "study").length,
          baseline: completed.filter((game) => game.lane === lane && game.profile === "baseline")
            .length,
        })),
      },
      interpretation:
        "単独1位と同率1位を区別し、手数上限は未終局です。中断局はattemptsへ残し、正式サンプルに含めず再開時に再実行します。ON/OFFと席替えは同一開始seedの反復です。固定workは等時間比較ではありません。forced_legal_actionは唯一の合法手を即確定し、評価/PVは未計算（depth/work=0）です。少数測定は棋力保証に使いません。",
      interrupted,
      failure: effectiveFailure,
      summary: summary(completed),
      byStrategy: Object.fromEntries(
        (options.compareStrategies ?? [options.searchStrategy ?? "adaptive"]).map((strategy) => [
          strategy,
          summary(
            completed.filter(
              (game) => (game.searchStrategy ?? options.searchStrategy ?? "adaptive") === strategy,
            ),
          ),
        ]),
      ),
      formalAssessment: options.formal
        ? assessFormalStrength(completed, unchanged, {
            interrupted,
            failure: effectiveFailure,
            unresolvedWorkerFailures,
          })
        : null,
      games: completed,
      attempts: incomplete,
      workerFailures: observedFailures,
      invalidatedGames: isolated,
      positions: measuredPositions,
      recordsHash: strengthRecordsHash(
        completed,
        incomplete,
        measuredPositions,
        observedFailures,
        isolated,
      ),
    };
  };
  const persist = () => {
    return writer.write(report());
  };
  try {
    if (options.resume) {
      const saved = validateStrengthResume(await Bun.file(options.output).json(), contract, jobs);
      games.push(...saved.games);
      attempts.push(...saved.attempts);
      positions.push(...saved.positions);
      startedAt = saved.startedAt;
      resumeCount = saved.resumeCount;
      workerFailures.push(...saved.workerFailures);
      invalidatedGames.push(...saved.invalidatedGames);
      await persist();
    } else {
      // 採否条件・全job・実行環境を、結果が出る前に排他的に保存します。
      await writer.write(report(), true);
    }
    startedMeasurements = true;
    pool = createStrengthProcessPool({
      options,
      concurrency: options.concurrency,
      contractHash: hashJson(contract),
      runnerVersion: strengthRunnerVersion,
      code: codeIdentity,
      opponentId: opponent.id,
      opponentMetadata: opponent.metadata,
    });
    if (interrupted) pool.stop();
    const completed = new Set(games.map((game) => game.jobId));
    await runStrengthQueue(
      jobs,
      options.concurrency,
      completed,
      async (job, lane) => {
        activeJobs[lane] = job.id;
        try {
          if (!sourceUnchanged()) throw new Error("測定中にソースまたはHEADが変更されました");
          const game = await pool!.run(job, lane);
          activeJobs[lane] = null;
          if (game.interrupted) attempts.push(game);
          else {
            games.push(game);
            completed.add(job.id);
          }
          await persist();
          console.info(
            JSON.stringify({
              game: games.length,
              jobId: job.id,
              lane,
              profile: job.profile,
              restricted: job.restricted,
              seed: job.seed,
              seat: job.seat,
              status: game.sample.status,
              moves: game.sample.moves,
              soleFirst: game.sample.soleFirst,
              termination: game.sample.termination,
            }),
          );
        } catch (error) {
          if (interrupted && error instanceof StrengthProcessStoppedError) return;
          interrupted = true;
          pool!.stop();
          failure ??= error instanceof Error ? error.message : String(error);
          throw error;
        } finally {
          activeJobs[lane] = null;
        }
      },
      () => interrupted,
    );
    await pool.close();
    if (options.positionsFile && !interrupted) {
      if ("timeMs" in options.budget)
        sampleRuntime = createStudySearchRuntime({
          threads: options.threads,
          memoryMb: options.memoryMb,
        });
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
              ? fixedWorkChoice(position, options.budget.work, profile, options.searchStrategy)
              : await timedChoice(
                  sampleRuntime!,
                  replay,
                  options.budget.timeMs,
                  profile,
                  position,
                  options.searchStrategy,
                );
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
          await persist();
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
    await persist();
  } catch (error) {
    failure ??= error instanceof Error ? error.message : String(error);
    interrupted = true;
    // 条件不一致のresumeでは、元の記録を変更しません。
    if (startedMeasurements) await persist().catch(() => {});
    throw error;
  } finally {
    await writer.idle();
    try {
      await Promise.all([pool?.close(), sampleRuntime?.close()]);
    } finally {
      opponent.dispose();
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
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
    "search-strategy",
    "compare-strategies",
    "max-plies",
    "output",
    "positions",
    "samples-only",
    "formal",
    "concurrency",
    "resume",
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
    ["samples-only", "formal", "resume"].some(
      (key) => values.has(key) && !["true", "false"].includes(values.get(key)!),
    )
  )
    throw new Error("ルール・席・比較方式が不正です");
  const formal = values.get("formal") === "true";
  const strategy = values.get("search-strategy");
  if (strategy !== undefined && !["legacy", "adaptive", "dual"].includes(strategy))
    throw new Error("search-strategy must be legacy, adaptive or dual");
  const compareStrategies = values.get("compare-strategies")?.split(",");
  if (
    compareStrategies &&
    (strategy !== undefined ||
      compareStrategies.length !== 2 ||
      new Set(compareStrategies).size !== 2 ||
      compareStrategies.some((entry) => !["legacy", "adaptive", "dual"].includes(entry)))
  )
    throw new Error("compare-strategiesには異なる2方式を指定してください");
  if (formal && (strategy !== undefined || compareStrategies !== undefined))
    throw new Error("正式条件への探索方式の追加は別の測定計画にしてください");
  if ((strategy === "dual" || compareStrategies) && values.has("work"))
    throw new Error("二段階探索の対局比較は実時間予算で指定してください");
  if (
    compareStrategies &&
    (profiles.length !== 1 || values.has("positions") || values.get("samples-only") === "true")
  )
    throw new Error("方式比較は単一profileの対局で行ってください");
  const options: StrengthOptions = {
    budget: values.has("work")
      ? { work: integer("work", 8192, 1, 100000000) }
      : { timeMs: integer("time-ms", formal ? formalStrengthPlan.timeMs : 5000, 1, 3600000) },
    threads: integer("threads", 4, 1, 32),
    memoryMb: integer("memory-mb", 8192, 256, 65536),
    concurrency: integer("concurrency", formal ? formalStrengthPlan.concurrency : 1, 1, 2),
    seed: integer("seed", formal ? formalStrengthPlan.seed : 8360000, 1000000, 0xffffffff - 1000),
    seeds: integer("seeds", formal ? formalStrengthPlan.series : 2, 1, 1000),
    restrictions: restrictions.map((value) => value === "on"),
    seats: seats as Side[],
    profiles: profiles as StudyProfile[],
    maxPlies: integer("max-plies", 512, 1, 4096),
    output: resolve(values.get("output") ?? "/tmp/four-shogi-study-strength.json"),
    positionsFile: values.get("positions"),
    samplesOnly: values.get("samples-only") === "true",
    formal,
    ...(strategy ? { searchStrategy: strategy as StudySearchStrategy } : {}),
    ...(compareStrategies ? { compareStrategies: compareStrategies as StudySearchStrategy[] } : {}),
    resume: values.get("resume") === "true",
  };
  if (formal) validateFormalStrengthOptions(options);
  return options;
}
if (import.meta.main) await runStrength(argumentsFor(process.argv.slice(2)));
