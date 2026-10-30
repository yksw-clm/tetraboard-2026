import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { cpus, totalmem, release } from "node:os";
import { spawn } from "node:child_process";
import { sides } from "@tetraboard/four-shogi";
import { git, loadPlayer, repoRoot } from "../../../packages/four-shogi/bench/baseline";
import { hashJson } from "../../../packages/four-shogi/bench/singlesMeasurement";
import {
  createStrengthOpening,
  strengthCodeIdentity,
  strengthRunnerVersion,
  type RecordedGame,
  type StrengthOptions,
} from "./strength";
import { createStrengthProcessPool } from "./strengthProcessPool";
import {
  createPilotSchedule,
  numericSummary,
  pilotStrategies,
  summarizePilot,
} from "./strengthPilotResults";
import { readStrengthJournal, replayStrengthJournal, verifyStrengthGame } from "./strengthJournal";

function pilotSource() {
  return ["strengthPilot.ts", "strengthPilotResults.ts", "strengthPilotGuard.py"].map((path) => ({
    path,
    sha256: new Bun.CryptoHasher("sha256")
      .update(readFileSync(join(import.meta.dir, path)))
      .digest("hex"),
  }));
}
async function save(path: string, value: unknown) {
  await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2) + "\n");
  await rename(`${path}.tmp`, path);
}
export async function preparePilot(directory: string, seed: number, coldWorkers = false) {
  if (git("status", "--porcelain"))
    throw new Error("計測コードをコミットしてから事前登録してください");
  if (
    !Number.isSafeInteger(seed) ||
    seed < 1 ||
    seed >= 0xffffffff ||
    (seed >= 9440000 && seed <= 9440015)
  )
    throw new Error("未使用のseedを指定し、正式holdoutを避けてください");
  for (const part of ["games", "games/journals", "statistics", "diagnostics", "validation"])
    await mkdir(join(directory, part), { recursive: true });
  const auditPath = join(directory, "diagnostics/seed-audit.json");
  const audit = JSON.parse(await readFile(auditPath, "utf8"));
  if (audit.selectedSeed !== seed || audit.previouslyUsed !== false)
    throw new Error("seed調査記録がありません");
  const root = relative(repoRoot, directory);
  if (root.startsWith(".."))
    throw new Error("永続成果物はリポジトリ内のGit管理外領域に保存してください");
  const options: StrengthOptions = {
    budget: { timeMs: 2000 },
    threads: 4,
    memoryMb: coldWorkers ? 4096 : 8192,
    ...(coldWorkers ? { reuseSearchWorkers: false } : {}),
    concurrency: 1,
    seed,
    seeds: 1,
    restrictions: [false, true],
    seats: [...sides],
    profiles: ["study"],
    maxPlies: 1024,
    output: `${root}/checkpoint.json`,
    samplesOnly: true,
    compareStrategies: [...pilotStrategies],
    journalDirectory: `${root}/games/journals`,
  };
  const opponent = await loadPlayer("frozen");
  try {
    const openings = await Promise.all(
      options.restrictions.map(async (restricted) => {
        const opening = await createStrengthOpening(seed, restricted);
        return {
          seed,
          restricted,
          stateHash: opening.position.stateHash,
          replay: opening.replay,
          replayHash: hashJson(opening.replay),
        };
      }),
    );
    const plan = {
      schemaVersion: 1,
      id: "p1-4-strength-pilot-v1",
      registeredAt: new Date().toISOString(),
      code: strengthCodeIdentity(),
      pilotSource: pilotSource(),
      seedAuditHash: hashJson(audit),
      referenceHead: "09b497d4b879556e091f1f5dfa4a409483875d97",
      environment: {
        cpu: cpus()[0]?.model,
        logicalCpus: cpus().length,
        totalMemoryBytes: totalmem(),
        os: process.platform,
        release: release(),
        bun: Bun.version,
      },
      options,
      taskPartition: "root",
      opponent: { id: opponent.id, metadata: opponent.metadata },
      schedule: createPilotSchedule(options),
      openings,
      limits: {
        wallMs: 90 * 60000,
        stopNewGamesMs: 86 * 60000,
        cooperativeStopMs: 89 * 60000 + 45000,
        softRssMiB: 6144,
        hardRssMiB: 7168,
        maxWorkers: 8,
        sampleMs: 100,
      },
      pilot:
        "最初の3局を予備対局とし同じ24局へ保持します。系列・順序・条件を変えず、時間消費だけから残り時間を見積もります。追加系列・選択的再試行は行いません。",
      expectedDuration:
        "過去500msの平均184手を仮定すると候補46手×2秒で約92秒/局、24局約37分+Lv2・正本処理です。最長1024手では1局約9分以上となり24局は90分を超え得ます。",
      startRule:
        "開始後86分を超えるか、残り時間が直近3局の平均時間の1.2倍（最低60秒）を下回ると新しい局を開始しません。",
      instrumentation:
        "3方式共通のmeasureStages=true、既存root/default widths/extensions/evaluation。各適用手を同期append、完成局を原子的checkpoint。強制合法手は探索時間・深さの分母と分離します。" +
        (coldWorkers
          ? " 全方式4096MiB、毎手worker新規作成。起動時間を予算と実時間へ含めます。"
          : " メモリ8192MiB、既存worker再利用設定。"),
      inference:
        "独立系列n=1。24局を24独立標本とせず区間推定しません。完全な24局のseedを主比較、完成3局組とその他の途中結果は参考として分離します。",
    };
    await writeFile(join(directory, "plan.json"), JSON.stringify(plan, null, 2) + "\n", {
      flag: "wx",
    });
    console.log(
      JSON.stringify({
        registered: true,
        source: plan.code.commit,
        seed,
        games: plan.schedule.length,
        planHash: hashJson(plan),
      }),
    );
    return plan;
  } finally {
    opponent.dispose();
  }
}
type PilotPlan = Awaited<ReturnType<typeof preparePilot>>;

async function observations(directory: string, games: readonly RecordedGame[]) {
  return games.map((game) => ({
    game,
    choices: readStrengthJournal(
      join(directory, "games/journals", `${game.jobId}.jsonl`),
    ).entries.flatMap((row) => (row.type === "move" && row.choice ? [row.choice] : [])),
  }));
}
export async function verifyPilot(directory: string) {
  const plan: PilotPlan = JSON.parse(await readFile(join(directory, "plan.json"), "utf8"));
  const checkpoint = JSON.parse(await readFile(join(directory, "checkpoint.json"), "utf8")) as {
    games: RecordedGame[];
    planHash: string;
  };
  if (checkpoint.planHash !== hashJson(plan)) throw new Error("計画hashが一致しません");
  const validations = [];
  for (const game of checkpoint.games) {
    const job = plan.schedule.find((value) => value.id === game.jobId);
    if (!job) throw new Error("計画外の局です");
    const opening = plan.openings.find((value) => value.restricted === game.restricted)!;
    if (
      hashJson({ ...game.replay, events: game.replay.events.slice(0, 12) }) !== opening.replayHash
    )
      throw new Error("事前登録した開始棋譜と一致しません");
    validations.push(
      await verifyStrengthGame(game, job, join(directory, "games/journals", `${game.jobId}.jsonl`)),
    );
  }
  const statistics = summarizePilot(plan.schedule, await observations(directory, checkpoint.games));
  await save(join(directory, "validation/replay.json"), {
    planHash: hashJson(plan),
    games: validations,
    allValid: true,
    events: validations.reduce((sum, row) => sum + row.events, 0),
  });
  await save(join(directory, "statistics/results.json"), statistics);
  return statistics;
}

export async function runPilot(directory: string) {
  const plan: PilotPlan = JSON.parse(await readFile(join(directory, "plan.json"), "utf8"));
  if (
    hashJson(plan.code) !== hashJson(strengthCodeIdentity()) ||
    hashJson(plan.pilotSource) !== hashJson(pilotSource()) ||
    git("status", "--porcelain")
  )
    throw new Error("事前登録後にコードまたはHEADが変わっています");
  const startedAt = new Date().toISOString();
  const before = performance.now();
  await writeFile(
    join(directory, "started.json"),
    JSON.stringify({ startedAt, pid: process.pid, planHash: hashJson(plan) }),
    { flag: "wx" },
  );
  const guard = spawn(
    "python3",
    [
      join(import.meta.dir, "strengthPilotGuard.py"),
      "--pid",
      String(process.pid),
      "--directory",
      directory,
      "--wall-seconds",
      String(plan.limits.wallMs / 1000),
      "--soft-mib",
      String(plan.limits.softRssMiB),
      "--hard-mib",
      String(plan.limits.hardRssMiB),
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  let guardExited = false;
  const guardClosed = new Promise<void>((resolve) =>
    guard.once("exit", () => {
      guardExited = true;
      resolve();
    }),
  );
  const pool = createStrengthProcessPool({
    options: plan.options,
    concurrency: 1,
    contractHash: hashJson(plan),
    runnerVersion: strengthRunnerVersion,
    code: plan.code,
    opponentId: plan.opponent.id,
    opponentMetadata: plan.opponent.metadata,
    shutdownTimeoutMs: 1000,
  });
  const games: RecordedGame[] = [];
  const durations: number[] = [];
  let stopReason: string | null = null;
  let failure: string | null = null;
  const requestStop = () => {
    stopReason ??= "external_guard_or_signal";
    pool.stop();
  };
  let closingGuard = false;
  guard.once("error", (error) => {
    failure = String(error);
    requestStop();
  });
  guard.once("exit", () => {
    if (!closingGuard) {
      failure ??= "資源監視が予期せず終了しました";
      requestStop();
    }
  });
  process.on("SIGINT", requestStop);
  process.on("SIGTERM", requestStop);
  const timer = setTimeout(() => {
    stopReason ??= "wall_clock_limit";
    pool.stop();
  }, plan.limits.cooperativeStopMs);
  const checkpoint = async () =>
    save(join(directory, "checkpoint.json"), {
      schemaVersion: 1,
      planHash: hashJson(plan),
      startedAt,
      updatedAt: new Date().toISOString(),
      elapsedMs: performance.now() - before,
      stopReason,
      failure,
      failures: pool.failures(),
      games,
    });
  try {
    const guardDeadline = performance.now() + 5000;
    while (!existsSync(join(directory, "diagnostics/guard-ready.json"))) {
      if (guardExited || failure || performance.now() > guardDeadline)
        throw new Error("資源監視を開始できません");
      await Bun.sleep(20);
    }
    await checkpoint();
    for (const [index, job] of plan.schedule.entries()) {
      const elapsed = performance.now() - before;
      const estimate = numericSummary(durations.slice(-3)).mean;
      const needed = Math.max(60000, (estimate ?? 0) * 1.2);
      if (stopReason || guardExited) {
        stopReason ??= "guard_exited";
        break;
      }
      if (
        elapsed >= plan.limits.stopNewGamesMs ||
        plan.limits.cooperativeStopMs - elapsed < needed
      ) {
        stopReason = "insufficient_time_for_next_game";
        break;
      }
      if (
        hashJson(plan.code) !== hashJson(strengthCodeIdentity()) ||
        hashJson(plan.pilotSource) !== hashJson(pilotSource())
      )
        throw new Error("対局間にソースが変わりました。測定を停止します");
      appendFileSync(
        join(directory, "diagnostics/starts.jsonl"),
        JSON.stringify({ index, job, at: new Date().toISOString(), elapsedMs: elapsed }) + "\n",
      );
      const gameBefore = performance.now();
      let game: RecordedGame;
      try {
        game = await pool.run(job, 0);
      } catch (error) {
        failure = String(error);
        stopReason ??= "game_parent_error";
        const journalPath = join(directory, "games/journals", `${job.id}.jsonl`);
        if (existsSync(journalPath)) {
          const journal = readStrengthJournal(journalPath);
          game = await replayStrengthJournal(journal.entries, job);
          await save(join(directory, "diagnostics/recovery.json"), {
            jobId: job.id,
            failure,
            truncatedTail: journal.truncatedTail,
            movesRecovered: game.sample.moves,
          });
        } else throw error;
      }
      games.push(game);
      durations.push(performance.now() - gameBefore);
      await save(join(directory, "games", `${job.id}.json`), game);
      await checkpoint();
      console.log(
        JSON.stringify({
          index: index + 1,
          strategy: job.searchStrategy,
          seat: job.seat,
          restricted: job.restricted,
          status: game.sample.status,
          rank: game.sample.rank,
          soleFirst: game.sample.soleFirst,
          moves: game.sample.moves,
          elapsedMs: performance.now() - before,
        }),
      );
      if (index === 2)
        await save(join(directory, "diagnostics/pilot-estimate.json"), {
          firstThreeDurationsMs: durations,
          estimated24Ms: (numericSummary(durations).mean ?? 0) * 24,
          measuredAt: new Date().toISOString(),
          policy: "予備対局を保持し、開始条件を変えず残り時間だけで停止判断します",
        });
      if (game.interrupted || failure) break;
    }
  } catch (error) {
    failure = String(error);
    stopReason ??= "measurement_error";
  } finally {
    clearTimeout(timer);
    await pool.close();
    await checkpoint();
    closingGuard = true;
    guard.kill("SIGTERM");
    await guardClosed;
    process.off("SIGINT", requestStop);
    process.off("SIGTERM", requestStop);
  }
  await save(join(directory, "validation/source-after.json"), {
    code: strengthCodeIdentity(),
    pilotSource: pilotSource(),
    unchanged:
      hashJson(plan.code) === hashJson(strengthCodeIdentity()) &&
      hashJson(plan.pilotSource) === hashJson(pilotSource()),
    dirty: git("status", "--porcelain").length > 0,
    elapsedMs: performance.now() - before,
    endedAt: new Date().toISOString(),
  });
  await verifyPilot(directory);
  if (failure) throw new Error(failure);
}

if (import.meta.main) {
  const [mode, directory, rawSeed] = Bun.argv.slice(2);
  if (!directory)
    throw new Error("prepare|prepare-cold|run|verify <成果物ディレクトリ> [未使用seed]");
  const root = resolve(directory);
  if (mode === "prepare") await preparePilot(root, Number(rawSeed));
  else if (mode === "prepare-cold") await preparePilot(root, Number(rawSeed), true);
  else if (mode === "run") await runPilot(root);
  else if (mode === "verify") console.log(JSON.stringify(await verifyPilot(root)));
  else throw new Error("不明なmodeです");
}
