import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  argumentsFor,
  assessFormalStrength,
  createStrengthJobs,
  createStrengthReportWriter,
  fixedWorkChoice,
  forcedLegalChoice,
  runStrength,
  runStrengthQueue,
  resolveStrengthExecution,
  strengthProcessSourceIdentity,
  strengthRecordsHash,
  strengthRunnerVersion,
  strengthScheduleVersion,
  validateStrengthResume,
  type RecordedGame,
  type StrengthJob,
  type StrengthResumeContract,
} from "../bench/strength";
import type { SinglesSample } from "../../../packages/four-shogi/bench/singlesMeasurement";
import { sides } from "@tetraboard/four-shogi";
import type { StrengthParentFailure } from "../bench/strengthProcessProtocol";
import {
  createAnalysisSetupPosition,
  getAnalysisLegalActions,
} from "@tetraboard/four-shogi/analysis";

const directories: string[] = [];

test("旧新探索の短期比較は方式をjob識別へ含め、正式条件へ混ぜない", () => {
  const legacy = argumentsFor(["--search-strategy", "legacy"]);
  const adaptive = argumentsFor(["--search-strategy", "adaptive"]);
  expect(legacy.searchStrategy).toBe("legacy");
  expect(createStrengthJobs(legacy)[0].id).not.toBe(createStrengthJobs(adaptive)[0].id);
  expect(() => argumentsFor(["--search-strategy", "unknown"])).toThrow("search-strategy");
  expect(() => argumentsFor(["--formal", "true", "--search-strategy", "legacy"])).toThrow(
    "正式条件",
  );
});
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function temporaryOutput() {
  const directory = await mkdtemp(join(tmpdir(), "study-strength-"));
  directories.push(directory);
  return join(directory, "report.json");
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function samples(wins: (profile: "study" | "baseline", series: number, seat: number) => boolean) {
  const games: Pick<RecordedGame, "profile" | "restricted" | "sample">[] = [];
  for (const restricted of [false, true])
    for (const profile of ["study", "baseline"] as const)
      for (let series = 0; series < 16; series++)
        for (const [index, seat] of sides.entries()) {
          const soleFirst = wins(profile, series, index);
          const sample: SinglesSample = {
            matchId: `${profile}:${restricted}:${series}:${seat}`,
            seriesId: `series:${series}`,
            startKind: "opening",
            seed: 9_440_000 + series,
            seat,
            lineup: { south: "cpu", west: "cpu", north: "cpu", east: "cpu" },
            status: "finished",
            moves: 100,
            rank: soleFirst ? 1 : 2,
            soleFirst,
            tiedFirst: false,
            noSoleWinner: false,
            termination: "last_player",
            eliminations: [],
            finalStateHash: "fixture",
            trajectoryHash: "fixture",
            decisions: [],
          };
          games.push({ profile, restricted, sample });
        }
  return games;
}

test("正式測定の予算と局数を結果取得前に固定する", () => {
  const options = argumentsFor(["--formal", "true"]);
  expect(options).toMatchObject({
    budget: { timeMs: 1000 },
    threads: 4,
    memoryMb: 8192,
    concurrency: 2,
    seed: 9440000,
    seeds: 16,
    maxPlies: 512,
  });
  expect(() => argumentsFor(["--formal", "true", "--time-ms", "5000"])).toThrow("正式測定");
  expect(() => argumentsFor(["--formal", "true", "--seeds", "2"])).toThrow("正式測定");
  expect(() => argumentsFor(["--formal", "true", "--concurrency", "1"])).toThrow("正式測定");
  expect(() => argumentsFor(["--formal", "true", "--seed", "9410000"])).toThrow("正式測定");
  expect(argumentsFor(["--concurrency", "1", "--resume", "true"]).resume).toBe(true);
  expect(() => argumentsFor(["--formal", "true", "--minimum-rate", "0.1"])).toThrow("未知");
});

test("256jobのshuffleは固定seedで再現でき、両profileをペアにしてslotの固定を避ける", () => {
  const options = argumentsFor(["--formal", "true"]);
  const jobs = createStrengthJobs(options);
  expect(jobs).toHaveLength(256);
  expect(new Set(jobs.map((job) => job.id)).size).toBe(256);
  expect(createStrengthJobs(options)).toEqual(jobs);
  for (let index = 0; index < jobs.length; index += 2) {
    expect(jobs[index].seed).toBe(jobs[index + 1].seed);
    expect(jobs[index].seat).toBe(jobs[index + 1].seat);
    expect(jobs[index].restricted).toBe(jobs[index + 1].restricted);
    expect(jobs[index].profile).not.toBe(jobs[index + 1].profile);
  }
  for (const slot of [0, 1])
    expect(jobs.filter((job, index) => index % 2 === slot && job.profile === "study")).toHaveLength(
      64,
    );
  const oneLane = createStrengthJobs({ ...options, concurrency: 1 });
  expect(oneLane[0].id).not.toBe(jobs[0].id);
});

function recorded(job: StrengthJob, lane = 0, interrupted = false): RecordedGame {
  const sample = samples(() => false)[0].sample;
  return {
    jobId: job.id,
    lane,
    profile: job.profile,
    restricted: job.restricted,
    interrupted,
    sample: {
      ...sample,
      matchId: job.id,
      seed: job.seed,
      seat: job.seat,
      termination: interrupted ? "interrupted" : "last_player",
    },
    replay: {
      schemaVersion: 1,
      ruleProfileId: "tetraboard-four-shogi-singles-v1",
      rulesVersion: 1,
      initial: {
        mode: "singles",
        players: { south: "s", west: "w", north: "n", east: "e" },
        threePlayerAttackProhibited: job.restricted,
      },
      events: [],
    },
    candidateElapsedMs: [],
    candidateDepths: [],
    candidateReasons: {},
  };
}
function resumeContract(jobs: readonly StrengthJob[]): StrengthResumeContract {
  return {
    runnerVersion: strengthRunnerVersion,
    scheduleVersion: strengthScheduleVersion,
    code: { commit: "fixed", source: "engine", runtime: "runtime", runner: "runner" },
    environment: {
      platform: "darwin",
      architecture: "arm64",
      cpu: "fixture",
      cpuCount: 10,
      memoryBytes: 24 * 1024 ** 3,
      bun: Bun.version,
    },
    options: { concurrency: 2, seed: 9440000 },
    opponent: { selector: "frozen" },
    jobIds: jobs.map((job) => job.id),
  };
}
function resumeReport(
  contract: StrengthResumeContract,
  games: RecordedGame[],
  attempts: RecordedGame[] = [],
) {
  return {
    schemaVersion: 3,
    runnerVersion: strengthRunnerVersion,
    code: { sourceUnchanged: true },
    contract,
    contractHash: new Bun.CryptoHasher("sha256").update(JSON.stringify(contract)).digest("hex"),
    startedAt: "2026-10-28T00:00:00.000Z",
    resumeCount: 0,
    games,
    attempts,
    positions: [],
    workerFailures: [],
    invalidatedGames: [],
    recordsHash: strengthRecordsHash(games, attempts, []),
  };
}

test("2つのlaneは独立に一局ずつ進み、同時完了の中間保存とresumeで対局を重複しない", async () => {
  const output = await temporaryOutput();
  const jobs = createStrengthJobs(argumentsFor(["--formal", "true"])).slice(0, 4);
  const contract = resumeContract(jobs);
  const writer = createStrengthReportWriter(output);
  const games: RecordedGame[] = [];
  const inFlight = new Set<number>();
  const entered = [deferred<void>(), deferred<void>()];
  const release = deferred<void>();
  const seen: string[] = [];
  await writer.write(resumeReport(contract, []), true);
  await expect(createStrengthReportWriter(output).write({}, true)).rejects.toThrow();
  const running = runStrengthQueue(jobs, 2, new Set(), async (job, lane) => {
    expect(inFlight.has(lane)).toBe(false);
    inFlight.add(lane);
    entered[lane].resolve();
    await release.promise;
    games.push(recorded(job, lane));
    seen.push(job.id);
    const written = writer.write(resumeReport(contract, games));
    inFlight.delete(lane);
    await written;
  });
  await Promise.all(entered.map((value) => value.promise));
  expect(inFlight.size).toBe(2);
  release.resolve();
  await running;
  await writer.idle();
  expect(new Set(seen).size).toBe(4);
  const saved = validateStrengthResume(JSON.parse(await readFile(output, "utf8")), contract, jobs);
  expect(saved.games.map((game) => game.jobId)).toEqual(seen);
  const resumed: string[] = [];
  await runStrengthQueue(
    jobs,
    2,
    new Set(saved.games.slice(0, 2).map((game) => game.jobId)),
    async (job) => {
      resumed.push(job.id);
    },
  );
  expect(resumed.sort()).toEqual(
    jobs
      .filter((job) => !saved.games.slice(0, 2).some((game) => game.jobId === job.id))
      .map((job) => job.id)
      .sort(),
  );
});

test("fatal error時は別laneの終了を待ち、新しいjobを開始しない", async () => {
  const jobs = createStrengthJobs(argumentsFor(["--formal", "true"])).slice(0, 4);
  const entered = deferred<void>();
  const release = deferred<void>();
  const started: string[] = [];
  let otherFinished = false;
  const run = runStrengthQueue(jobs, 2, new Set(), async (job, lane) => {
    started.push(job.id);
    if (lane === 0) {
      await entered.promise;
      throw new Error("fixture failure");
    }
    entered.resolve();
    await release.promise;
    otherFinished = true;
  });
  await entered.promise;
  expect(otherFinished).toBe(false);
  release.resolve();
  await expect(run).rejects.toThrow("fixture failure");
  expect(otherFinished).toBe(true);
  expect(started).toHaveLength(2);
});

test("resumeは旧形式・別コード/環境/条件・未知job・重複・破損を拒否する", () => {
  const jobs = createStrengthJobs(argumentsFor(["--formal", "true"]));
  const contract = resumeContract(jobs);
  const report = resumeReport(contract, [recorded(jobs[0])], [recorded(jobs[1], 1, true)]);
  expect(validateStrengthResume(report, contract, jobs).resumeCount).toBe(1);
  expect(() => validateStrengthResume({ ...report, schemaVersion: 1 }, contract, jobs)).toThrow();
  expect(() =>
    validateStrengthResume({ ...report, code: { sourceUnchanged: false } }, contract, jobs),
  ).toThrow();
  for (const changed of [
    { ...contract, code: { source: "changed" } },
    { ...contract, environment: { cpu: "other-host" } },
    { ...contract, options: { concurrency: 1, seed: 9410000 } },
  ])
    expect(() => validateStrengthResume(report, changed, jobs)).toThrow("一致しません");
  expect(() =>
    validateStrengthResume({ ...report, recordsHash: "broken" }, contract, jobs),
  ).toThrow("ハッシュ");
  expect(() =>
    validateStrengthResume(
      resumeReport(contract, [recorded(jobs[0]), recorded(jobs[0])]),
      contract,
      jobs,
    ),
  ).toThrow("重複");
  expect(() =>
    validateStrengthResume(
      resumeReport(contract, [{ ...recorded(jobs[0]), jobId: "unknown" }]),
      contract,
      jobs,
    ),
  ).toThrow("job ID");
  expect(() =>
    validateStrengthResume(resumeReport(contract, [recorded(jobs[0], 0, true)]), contract, jobs),
  ).toThrow("中断");
});

test("既存の測定ファイルはresumeを明示しなければ上書きしない", async () => {
  const output = await temporaryOutput();
  const original = "previous measurement\n";
  await writeFile(output, original);
  await expect(
    runStrength(argumentsFor(["--output", output, "--work", "1", "--max-plies", "1"])),
  ).rejects.toThrow("上書きしません");
  expect(await readFile(output, "utf8")).toBe(original);
});

test("唯一の合法手は両profile共通で即確定し、評価とPVを計算済みに見せない", async () => {
  const board = Array.from({ length: 9 }, () =>
    Array<{ side: (typeof sides)[number]; kind: "king" | "rook"; promoted: boolean } | null>(
      9,
    ).fill(null),
  );
  for (const [side, x, y] of [
    ["south", 0, 8],
    ["west", 0, 0],
    ["north", 8, 0],
    ["east", 8, 8],
  ] as const)
    board[y][x] = { side, kind: "king", promoted: false };
  board[4][1] = { side: "west", kind: "rook", promoted: false };
  const position = await createAnalysisSetupPosition({
    schemaVersion: 1,
    board,
    hands: Object.fromEntries(
      sides.map((side) => [side, { rook: 0, gold: 0, silver: 0, pawn: 0 }]),
    ),
    turn: "south",
    threePlayerAttackProhibited: false,
    eliminations: [],
  });
  const actions = getAnalysisLegalActions(position);
  expect(actions).toEqual([
    { type: "movePiece", from: { x: 0, y: 8 }, to: { x: 0, y: 7 }, promote: false },
  ]);
  for (const profile of ["study", "baseline"] as const)
    expect(fixedWorkChoice(position, 1, profile)).toMatchObject({
      action: actions[0],
      depth: 0,
      work: 0,
      reason: "forced_legal_action",
      evaluationComputed: false,
      principalVariationComputed: false,
    });
  expect(forcedLegalChoice(position)?.action).toEqual(actions[0]);
});

test("席とON/OFFがそろうまで正式棋力を判定しない", () => {
  const games = samples((profile, _series, seat) => seat < (profile === "study" ? 3 : 2));
  expect(assessFormalStrength(games).status).toBe("passed");
  expect(assessFormalStrength(games.slice(0, -1)).status).toBe("pending");
  expect(assessFormalStrength(games, false).status).toBe("invalid_source_changed");
});

test("全256件が勝率条件を満たしても停止・fatal・未解決の親障害があれば合格にしない", () => {
  const games = samples((profile, _series, seat) => seat < (profile === "study" ? 3 : 2));
  expect(assessFormalStrength(games).status).toBe("passed");
  expect(
    assessFormalStrength(games, true, {
      interrupted: true,
      failure: null,
      unresolvedWorkerFailures: 0,
    }).status,
  ).toBe("pending");
  expect(
    assessFormalStrength(games, true, {
      interrupted: true,
      failure: "cleanup failed",
      unresolvedWorkerFailures: 0,
    }).status,
  ).toBe("invalid_execution");
  expect(
    assessFormalStrength(games, true, {
      interrupted: false,
      failure: null,
      unresolvedWorkerFailures: 1,
    }).status,
  ).toBe("invalid_execution");
});

test("矛盾した結果を隔離してresumeでそのjobを再実行し、再完了した障害だけを解決済みにする", async () => {
  const jobs = createStrengthJobs(argumentsFor(["--formal", "true"])).slice(0, 1);
  const game = recorded(jobs[0]);
  const issue: StrengthParentFailure = {
    lane: 0,
    jobId: game.jobId,
    kind: "result_conflict",
    message: "conflicting result",
    resolved: false,
  };
  const isolated = resolveStrengthExecution({
    games: [game],
    invalidatedGames: [],
    workerFailures: [],
    currentWorkerFailures: [issue],
    sourceUnchanged: true,
    failure: null,
  });
  expect(isolated.games).toEqual([]);
  expect(isolated.invalidatedGames).toEqual([game]);
  expect(isolated.unresolvedWorkerFailures).toBe(1);
  const contract = resumeContract(jobs);
  const base = resumeReport(contract, isolated.games);
  const report = {
    ...base,
    workerFailures: isolated.workerFailures,
    invalidatedGames: isolated.invalidatedGames,
    recordsHash: strengthRecordsHash(
      isolated.games,
      [],
      [],
      isolated.workerFailures,
      isolated.invalidatedGames,
    ),
  };
  const saved = validateStrengthResume(report, contract, jobs);
  const rerun: string[] = [];
  await runStrengthQueue(jobs, 2, new Set(saved.games.map((entry) => entry.jobId)), async (job) => {
    rerun.push(job.id);
  });
  expect(rerun).toEqual([game.jobId]);
  const corrupt = {
    ...report,
    games: [game],
    recordsHash: strengthRecordsHash(
      [game],
      [],
      [],
      isolated.workerFailures,
      isolated.invalidatedGames,
    ),
  };
  expect(() => validateStrengthResume(corrupt, contract, jobs)).toThrow("未解決");
  const recovered = resolveStrengthExecution({
    games: [recorded(jobs[0], 1)],
    invalidatedGames: saved.invalidatedGames,
    workerFailures: saved.workerFailures,
    currentWorkerFailures: [],
    sourceUnchanged: true,
    failure: null,
  });
  expect(recovered.workerFailures[0].resolved).toBe(true);
  expect(recovered.unresolvedWorkerFailures).toBe(0);
  expect(recovered.failure).toBeNull();
  const infrastructure = resolveStrengthExecution({
    games: [game],
    invalidatedGames: [],
    workerFailures: [{ ...issue, jobId: null, kind: "cleanup" }],
    currentWorkerFailures: [],
    sourceUnchanged: true,
    failure: null,
  });
  expect(infrastructure.unresolvedWorkerFailures).toBe(1);
});

test("runnerのソース識別は結果JSONを含めず、対局親とIPCも含める", () => {
  const source = strengthProcessSourceIdentity();
  expect(source.files.map((entry) => entry.path)).toEqual([
    "strength.ts",
    "strengthGameWorker.ts",
    "strengthProcessPool.ts",
    "strengthProcessProtocol.ts",
  ]);
  expect(source.files.every((entry) => entry.sha256.length === 64)).toBe(true);
});

test("単独率40%と系列区間下限と同時間baselineを独立に検査する", () => {
  expect(
    assessFormalStrength(samples((profile, _series, seat) => seat < (profile === "study" ? 1 : 0)))
      .status,
  ).toBe("failed");
  const clustered = assessFormalStrength(
    samples((profile, series) => profile === "study" && series < 7),
  );
  expect(clustered.byRule[0].study!.soleFirstRate).toBeGreaterThanOrEqual(0.4);
  expect(clustered.byRule[0].study!.soleFirstInterval95![0]).toBeLessThanOrEqual(0.25);
  expect(clustered.status).toBe("failed");
  expect(
    assessFormalStrength(samples((profile, _series, seat) => seat < (profile === "study" ? 2 : 3)))
      .status,
  ).toBe("failed");
});

test("未終局と同率1位を単独勝ちへ数えない", () => {
  const games = samples(() => false).map((game) => ({
    ...game,
    sample: { ...game.sample, status: "unfinished" as const, rank: null, termination: "max_plies" },
  }));
  const result = assessFormalStrength(games);
  expect(result.status).toBe("failed");
  expect(result.byRule[0].study).toMatchObject({ games: 64, unfinished: 64, soleFirstRate: 0 });
});
