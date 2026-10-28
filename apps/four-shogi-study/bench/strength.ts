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
export const strengthRunnerVersion = "local-strength-two-lanes-v2";
export const strengthScheduleVersion = "balanced-pair-shuffle-v1";
export const formalStrengthPlan = Object.freeze({
  id: "local-study-holdout-two-lanes-v2",
  seed: 9420000,
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
          options.profiles.map((profile) => {
            const identity = {
              runnerVersion: strengthRunnerVersion,
              seed: options.seed + offset,
              restricted,
              seat,
              profile,
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
            };
          }),
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
): Choice {
  const forced = forcedLegalChoice(position);
  if (forced) return forced;
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
          : await timedChoice(runtime!, replay, options.budget.timeMs, profile, position);
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
      "正式測定はseed9420000から16系列・4席・ON/OFF・両profile・各局1秒/4プロセス/8GiB・2局並列・512手に固定します",
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
      : !complete
        ? "pending"
        : byRule.every((entry) => entry.passed)
          ? "passed"
          : "failed",
    byRule,
  };
}
export function strengthRecordsHash(
  games: readonly RecordedGame[],
  attempts: readonly RecordedGame[],
  positions: readonly unknown[],
) {
  return hashJson({ games, attempts, positions });
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
} {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("再開する測定記録が不正です");
  const saved = input as Record<string, unknown>;
  if (
    saved.schemaVersion !== 2 ||
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
    typeof saved.startedAt !== "string" ||
    !Number.isFinite(Date.parse(saved.startedAt)) ||
    !Number.isSafeInteger(saved.resumeCount) ||
    (saved.resumeCount as number) < 0
  )
    throw new Error("再開する測定の保存形式が不正です");
  const games = saved.games as RecordedGame[];
  const attempts = saved.attempts as RecordedGame[];
  if (saved.recordsHash !== strengthRecordsHash(games, attempts, saved.positions))
    throw new Error("再開する測定結果のハッシュが一致しません");
  const expected = new Map(jobs.map((job) => [job.id, job]));
  const seen = new Set<string>();
  for (const game of [...games, ...attempts]) {
    const job = expected.get(game?.jobId);
    if (
      !job ||
      game.profile !== job.profile ||
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
  for (const game of games) {
    if (game.interrupted || game.sample.termination === "interrupted" || seen.has(game.jobId))
      throw new Error("再開する完了対局に中断・重複jobがあります");
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
  const runnerSourceHash = hashJson(await Bun.file(import.meta.path).text());
  const commit = git("rev-parse", "HEAD");
  const dirty = git("status", "--porcelain").length > 0;
  const sourceUnchanged = () =>
    git("rev-parse", "HEAD") === commit &&
    sourceIdentity(resolve(repoRoot, "packages/four-shogi/src")).sha256 === source.sha256 &&
    sourceIdentity(resolve(import.meta.dir, "../src/search")).sha256 === runtimeSource.sha256 &&
    sourceIdentity(resolve(import.meta.dir, "../src/domain")).sha256 === domainSource.sha256 &&
    sourceIdentity(resolve(repoRoot, "packages/four-shogi/bench")).sha256 ===
      measurementSource.sha256 &&
    hashJson(readFileSync(import.meta.path, "utf8")) === runnerSourceHash;
  const opponent = await loadPlayer("frozen");
  const runtimes: (StudySearchRuntime | null)[] = [];
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
    code: {
      commit,
      source: source.sha256,
      runtimeSource: runtimeSource.sha256,
      domainSource: domainSource.sha256,
      measurementSource: measurementSource.sha256,
      runnerSourceHash,
    },
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
      maxPlies: options.maxPlies,
      positionsFile: options.positionsFile ?? null,
      samplesOnly: options.samplesOnly,
      formal: options.formal ?? false,
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
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const report = () => {
    const unchanged = sourceUnchanged();
    const completed = [...games];
    const incomplete = [...attempts];
    const measuredPositions = [...positions];
    return {
      schemaVersion: 2,
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
        runnerSourceHash,
        sourceUnchanged: unchanged,
      },
      contract,
      contractHash: hashJson(contract),
      options,
      opponent: opponent.metadata,
      execution: {
        concurrency: options.concurrency,
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
      failure,
      summary: summary(completed),
      formalAssessment: options.formal ? assessFormalStrength(completed, unchanged) : null,
      games: completed,
      attempts: incomplete,
      positions: measuredPositions,
      recordsHash: strengthRecordsHash(completed, incomplete, measuredPositions),
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
      await persist();
    } else {
      // 採否条件・全job・実行環境を、結果が出る前に排他的に保存します。
      await writer.write(report(), true);
    }
    for (let lane = 0; lane < options.concurrency; lane++)
      runtimes.push(
        "timeMs" in options.budget
          ? createStudySearchRuntime({ threads: options.threads, memoryMb: options.memoryMb })
          : null,
      );
    const completed = new Set(games.map((game) => game.jobId));
    const openings = new Map<string, Promise<Opening>>();
    await runStrengthQueue(
      jobs,
      options.concurrency,
      completed,
      async (job, lane) => {
        activeJobs[lane] = job.id;
        try {
          if (!sourceUnchanged()) throw new Error("測定中にソースまたはHEADが変更されました");
          const key = `${job.seed}:${job.restricted}`;
          let start = openings.get(key);
          if (!start) {
            start = opening(job.seed, job.restricted);
            openings.set(key, start);
          }
          const game = await play(
            await start,
            job,
            lane,
            options,
            opponent,
            runtimes[lane],
            () => interrupted,
          );
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
          interrupted = true;
          failure ??= error instanceof Error ? error.message : String(error);
          throw error;
        } finally {
          activeJobs[lane] = null;
        }
      },
      () => interrupted,
    );
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
              : await timedChoice(runtimes[0]!, replay, options.budget.timeMs, profile, position);
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
    if (runtimes.length) await persist().catch(() => {});
    throw error;
  } finally {
    await writer.idle();
    try {
      await Promise.all(runtimes.map((runtime) => runtime?.close()));
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
    resume: values.get("resume") === "true",
  };
  if (formal) validateFormalStrengthOptions(options);
  return options;
}
if (import.meta.main) await runStrength(argumentsFor(process.argv.slice(2)));
