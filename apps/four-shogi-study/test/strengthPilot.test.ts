import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, appendFile, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getAnalysisLegalActions } from "@tetraboard/four-shogi/analysis";
import {
  argumentsFor,
  createStrengthGameRunner,
  createStrengthOpening,
  type RecordedGame,
} from "../bench/strength";
import {
  createPilotSchedule,
  pilotStrategies,
  summarizePilot,
} from "../bench/strengthPilotResults";
import {
  createStrengthJournal,
  readStrengthJournal,
  replayStrengthJournal,
  verifyStrengthGame,
  type StrengthJournalEntry,
} from "../bench/strengthJournal";
import { loadPlayer } from "../../../packages/four-shogi/bench/baseline";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
const options = () => ({
  ...argumentsFor([
    "--compare-strategies",
    "adaptive,dual",
    "--profiles",
    "study",
    "--seed",
    "9430300",
    "--seeds",
    "1",
    "--time-ms",
    "2000",
    "--concurrency",
    "1",
    "--max-plies",
    "1024",
  ]),
  compareStrategies: [...pilotStrategies],
});

test("worker再利用の条件を対局IDへ含め、既存条件と混同しない", () => {
  const defaults = createPilotSchedule(options());
  const cold = createPilotSchedule({ ...options(), reuseSearchWorkers: false });
  expect(cold).toHaveLength(24);
  for (const [index, job] of cold.entries()) {
    expect(job.id).not.toBe(defaults[index].id);
    expect(job.seed).toBe(defaults[index].seed);
    expect(job.searchStrategy).toBe(defaults[index].searchStrategy);
  }
});

test("独立1系列の24局を同条件3局ずつに束ね、方式順を循環する", () => {
  const jobs = createPilotSchedule(options());
  expect(jobs).toHaveLength(24);
  expect(new Set(jobs.map((job) => job.id)).size).toBe(24);
  for (let index = 0; index < 24; index += 3) {
    const block = jobs.slice(index, index + 3);
    expect(new Set(block.map((job) => `${job.seed}/${job.seat}/${job.restricted}`)).size).toBe(1);
    expect(block.map((job) => job.searchStrategy)).toEqual(
      pilotStrategies.map((_, offset) => pilotStrategies[(index / 3 + offset) % 3]),
    );
  }
});

test("未完了を敗北へ置換せず、完全seedと完成3局組を分離し、重複を拒否する", () => {
  const jobs = createPilotSchedule(options());
  const rows = jobs.map((job, index) => ({
    game: {
      jobId: job.id,
      searchStrategy: job.searchStrategy,
      restricted: job.restricted,
      sample: {
        matchId: job.id,
        seed: job.seed,
        seat: job.seat,
        status: index === 23 ? "unfinished" : "finished",
        rank: index === 23 ? null : 1,
        soleFirst: index !== 23,
        tiedFirst: false,
        termination: index === 23 ? "interrupted" : "last_player",
        eliminations: [],
        moves: 40,
      },
    } as unknown as RecordedGame,
    choices: [],
  }));
  const summary = summarizePilot(jobs, rows);
  expect(summary.completeSeeds).toEqual([]);
  expect(summary.partialMatchedCellsReference.cells).toHaveLength(7);
  expect(summary.allAttemptsDescriptive[rows[23].game.searchStrategy!].soleFirstRateAll).toBeNull();
  expect(
    summary.allAttemptsDescriptive[rows[23].game.searchStrategy!].soleFirstRateAmongFinished,
  ).toBe(1);
  expect(summary.primary.adaptive.attempted).toBe(0);
  expect(() => summarizePilot(jobs, [...rows, rows[0]])).toThrow("重複");
  rows[23].game.sample.status = "finished";
  rows[23].game.sample.rank = 2;
  expect(summarizePilot(jobs, rows).completeSeeds).toEqual([9430300]);
});

test("各着手journalを正本で再生し、中断を保存し、二重着手・hash改変を拒否する", async () => {
  const directory = await mkdtemp(join(tmpdir(), "strength-pilot-journal-"));
  directories.push(directory);
  const settings = { ...options(), budget: { work: 1 }, maxPlies: 3 };
  const opening = await createStrengthOpening(settings.seed, false);
  const job = createPilotSchedule(options()).find(
    (entry) => entry.seat === opening.position.state.turn && !entry.restricted,
  )!;
  const opponent = await loadPlayer("frozen");
  try {
    const entries: StrengthJournalEntry[] = [];
    const journal = createStrengthJournal(directory);
    const runner = createStrengthGameRunner(settings, opponent, null, (entry) => {
      entries.push(structuredClone(entry));
      journal(entry);
    });
    const game = await runner(job, 0, () => false);
    const path = join(directory, `${job.id}.jsonl`);
    expect((await verifyStrengthGame(game, job, path)).verified).toBe(true);
    expect(game.sample.moves).toBe(3);
    expect(game.sample.status).toBe("unfinished");
    expect((await replayStrengthJournal(entries, job)).interrupted).toBe(true);
    await expect(replayStrengthJournal([...entries, entries[1]], job)).rejects.toThrow("連番");
    const changed = structuredClone(entries);
    if (changed[1].type === "move") changed[1].afterHash = "corrupted";
    await expect(replayStrengthJournal(changed, job)).rejects.toThrow("hash");
    await appendFile(path, '{"partial":');
    expect(readStrengthJournal(path).truncatedTail).toBe(true);
    await expect(verifyStrengthGame(game, job, path)).rejects.toThrow("末尾");
    expect(getAnalysisLegalActions(opening.position).length).toBeGreaterThan(0);
  } finally {
    opponent.dispose();
  }
}, 10000);

test("外部guardは停止している親の壁時計を独立監視し、早期SIGINTを送る", async () => {
  const directory = await mkdtemp(join(tmpdir(), "strength-pilot-guard-"));
  directories.push(directory);
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      "process.on('SIGINT',()=>process.exit(0));setInterval(()=>{},1000)",
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  try {
    await Bun.sleep(50);
    // sandboxのOS列挙制限から独立させ、実時計・実signalの停止を検証します。
    const ps = join(directory, "ps");
    await writeFile(
      ps,
      `#!/bin/sh\nif kill -0 ${child.pid} 2>/dev/null; then printf '${child.pid} 0 128000 fixture\\n'; fi\n`,
    );
    await chmod(ps, 0o755);
    const guard = Bun.spawn(
      [
        "python3",
        join(import.meta.dir, "../bench/strengthPilotGuard.py"),
        "--pid",
        String(child.pid),
        "--directory",
        directory,
        "--wall-seconds",
        "15.2",
      ],
      {
        stdout: "ignore",
        stderr: "pipe",
        env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
      },
    );
    expect(await child.exited).toBe(0);
    expect(await guard.exited).toBe(0);
    const result = await Bun.file(join(directory, "diagnostics/resource-summary.json")).json();
    expect(result.reason).toBe("wall_clock_limit");
    expect(result.peakBytes.aggregation).toBeGreaterThan(0);
    expect(result.elapsedSeconds).toBeLessThan(3);
  } finally {
    child.kill();
  }
}, 10000);
