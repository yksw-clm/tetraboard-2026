import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { loadPlayer } from "../../../packages/four-shogi/bench/baseline";
import { hashJson } from "../../../packages/four-shogi/bench/singlesMeasurement";
import {
  argumentsFor,
  createStrengthGameRunner,
  createStrengthJobs,
  strengthCodeIdentity,
  strengthRunnerVersion,
} from "../bench/strength";
import {
  createStrengthProcessPool,
  type StrengthProcessPoolOptions,
} from "../bench/strengthProcessPool";
import type { StrengthProcessConfig } from "../bench/strengthProcessProtocol";

const resources: { pool?: ReturnType<typeof createStrengthProcessPool>; directory: string }[] = [];
afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.pool?.close();
    await rm(resource.directory, { recursive: true, force: true });
  }
});

async function fixture(
  runBody: string,
  readyBody = "send({ type: 'ready', code: m.config.code, opponentId: m.config.opponentId, opponentMetadata: m.config.opponentMetadata });",
) {
  const directory = await mkdtemp(join(tmpdir(), "strength-parent-"));
  const script = join(directory, "parent.ts");
  const prefix = JSON.stringify(directory);
  await writeFile(
    script,
    `
    import { writeFileSync, existsSync } from 'node:fs';
    import { spawn } from 'node:child_process';
    import { join } from 'node:path';
    const directory = ${prefix};
    let init;
    let job;
    let config;
    const send = (message) => process.send({ runId: init.runId, generation: init.generation, lane: init.lane, contractHash: config.contractHash, ...message });
    const result = (current, interrupted = false) => ({
      jobId: current.id, lane: init.lane, profile: current.profile, restricted: current.restricted, interrupted,
      sample: { matchId: current.id, seed: current.seed, seat: current.seat, moves: 0, termination: interrupted ? 'interrupted' : 'max_plies' },
      replay: { initial: { threePlayerAttackProhibited: current.restricted }, events: Array.from({length:12}, (_,index)=>({index})) },
    });
    process.on('message', async (m) => {
      if (m.type === 'init') {
        init = m; config = m.config;
        writeFileSync(join(directory, 'lane-' + init.lane + '.pid'), String(process.pid));
        ${readyBody}
        return;
      }
      if (m.type === 'run') { job = m.job; ${runBody}; return; }
      if (m.type === 'stop' && job) { send({ type: 'result', jobId: job.id, game: result(job, true) }); job = null; }
      if (m.type === 'close') process.exit(0);
    });
  `,
  );
  const options = argumentsFor([
    "--work",
    "1",
    "--seed",
    "9430100",
    "--seeds",
    "1",
    "--restrictions",
    "off",
    "--profiles",
    "study,baseline",
    "--seats",
    "south",
    "--concurrency",
    "2",
    "--max-plies",
    "1",
  ]);
  const config: StrengthProcessPoolOptions = {
    options,
    concurrency: 2,
    contractHash: "fixture-contract",
    runnerVersion: strengthRunnerVersion,
    code: { fixture: true },
    opponentId: "frozen-fixture",
    opponentMetadata: {
      selector: "frozen",
      commit: "fixture",
      source: { sha256: "fixture", files: [] },
      searchOptions: null,
      modelId: null,
      configurationOrigin: "fixture",
    },
    workerScript: pathToFileURL(script),
    startupTimeoutMs: 3000,
    shutdownTimeoutMs: 100,
  };
  const resource = {
    directory,
    pool: undefined as ReturnType<typeof createStrengthProcessPool> | undefined,
  };
  resources.push(resource);
  return {
    directory,
    config,
    jobs: createStrengthJobs(options),
    pool(overrides: Partial<StrengthProcessPoolOptions> = {}) {
      resource.pool = createStrengthProcessPool({ ...config, ...overrides });
      return resource.pool;
    },
    async pid(lane: number) {
      return Number(await readFile(join(directory, `lane-${lane}.pid`), "utf8"));
    },
  };
}

test("一方の対局親の同期処理が止まっていても他方は完了できる", async () => {
  const h = await fixture(`
    if (init.lane === 0) {
      writeFileSync(join(directory, 'blocked'), 'yes');
      const deadline = performance.now() + 5000;
      while (!existsSync(join(directory, 'release'))) {
        if (performance.now() > deadline) throw new Error('release timed out');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    } else {
      while (!existsSync(join(directory, 'blocked'))) await Bun.sleep(1);
    }
    send({type:'result', jobId:job.id, game:result(job)});
    job = null;
  `);
  const pool = h.pool();
  const blocked = pool.run(h.jobs[0], 0);
  const finished = await pool.run(h.jobs[1], 1);
  expect(finished.jobId).toBe(h.jobs[1].id);
  expect(await Bun.file(join(h.directory, "release")).exists()).toBe(false);
  await writeFile(join(h.directory, "release"), "yes");
  expect((await blocked).jobId).toBe(h.jobs[0].id);
  const pids = await Promise.all([h.pid(0), h.pid(1)]);
  expect(pids[0]).not.toBe(pids[1]);
  await pool.close();
  for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
});

test("旧世代と同一結果の再送を無視し、同じjobを二重実行しない", async () => {
  const h = await fixture(`
    const game = result(job);
    send({type:'result', generation:'old-generation', jobId:job.id, game});
    send({type:'result', jobId:job.id, game});
    send({type:'result', jobId:job.id, game});
    job = null;
  `);
  const pool = h.pool();
  expect((await pool.run(h.jobs[0], 0)).jobId).toBe(h.jobs[0].id);
  expect((await pool.run(h.jobs[1], 0)).profile).toBe(h.jobs[1].profile);
  await expect(pool.run(h.jobs[0], 1)).rejects.toThrow("実行済み");
  expect(pool.failures()).toEqual([]);
});

test("同じjobを起動前に別laneへ同時投入しても一度しか実行しない", async () => {
  const h = await fixture("send({type:'result',jobId:job.id,game:result(job)});job=null");
  const pool = h.pool();
  const first = pool.run(h.jobs[0], 0);
  await expect(pool.run(h.jobs[0], 1)).rejects.toThrow("実行済み");
  expect((await first).jobId).toBe(h.jobs[0].id);
});

test("対局親の異なるコードと、内容の異なる重複応答を拒否する", async () => {
  const mismatch = await fixture(
    "",
    "send({type:'ready',code:{wrong:true},opponentId:m.config.opponentId,opponentMetadata:m.config.opponentMetadata});",
  );
  const invalid = mismatch.pool();
  await expect(invalid.run(mismatch.jobs[0], 0)).rejects.toThrow("コード");
  await invalid.close();
  const duplicate = await fixture(`
    const game=result(job);
    send({type:'result',jobId:job.id,game});
    send({type:'result',jobId:job.id,game:{...game,interrupted:true}});
    job=null;
  `);
  const pool = duplicate.pool();
  await pool.run(duplicate.jobs[0], 0);
  await expect(pool.run(duplicate.jobs[1], 0)).rejects.toThrow();
  expect(pool.failures().some((entry) => entry.message.includes("変更されています"))).toBe(true);
  expect(pool.failures().find((entry) => entry.kind === "result_conflict")?.jobId).toBe(
    duplicate.jobs[0].id,
  );
});

test("停止時の途中棋譜を受け取り、未完了jobとして返す", async () => {
  const h = await fixture("writeFileSync(join(directory,'running'),'yes')");
  const pool = h.pool();
  const running = pool.run(h.jobs[0], 0);
  const deadline = performance.now() + 3000;
  while (!(await Bun.file(join(h.directory, "running")).exists())) {
    if (performance.now() > deadline) throw new Error("対局親がjobを開始しませんでした");
    await Bun.sleep(1);
  }
  pool.stop();
  const game = await running;
  expect(game.interrupted).toBe(true);
  expect(game.sample.termination).toBe("interrupted");
  await expect(pool.run(h.jobs[1], 1)).rejects.toThrow("受け付けません");
  await pool.close();
});

test("起動中の対局親を閉じてもready待機を残さない", async () => {
  const h = await fixture("", "");
  const pool = h.pool();
  const running = pool.run(h.jobs[0], 0);
  const rejected = running.then(
    () => null,
    (error: unknown) => error,
  );
  await pool.close();
  expect(String(await rejected)).toContain("起動を停止");
  expect(pool.failures()).toEqual([]);
});

test("停止要求を処理できない対局親にも停止期限を適用する", async () => {
  const h = await fixture(`
    writeFileSync(join(directory,'hung'),'yes');
    while(true) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1000);
  `);
  const pool = h.pool({ shutdownTimeoutMs: 30 });
  const running = pool.run(h.jobs[0], 0);
  const rejected = running.then(
    () => null,
    (error: unknown) => error,
  );
  const deadline = performance.now() + 3000;
  while (!(await Bun.file(join(h.directory, "hung")).exists())) {
    if (performance.now() > deadline) throw new Error("対局親がjobを開始しませんでした");
    await Bun.sleep(1);
  }
  const pid = await h.pid(0);
  pool.stop();
  expect(await rejected).toBeInstanceOf(Error);
  await pool.close();
  expect(() => process.kill(pid, 0)).toThrow();
  expect(pool.failures().some((entry) => entry.jobId === h.jobs[0].id)).toBe(true);
});

test("異常終了した対局親の孫プロセスも終了させる", async () => {
  const h = await fixture(`
    const grandchild = spawn(process.execPath,['--no-env-file','-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    writeFileSync(join(directory,'grandchild.pid'),String(grandchild.pid));
    process.exit(7);
  `);
  const pool = h.pool();
  await expect(pool.run(h.jobs[0], 0)).rejects.toThrow("終了しました");
  const grandchild = Number(await readFile(join(h.directory, "grandchild.pid"), "utf8"));
  await pool.close();
  expect(() => process.kill(grandchild, 0)).toThrow();
  expect(pool.failures().some((entry) => entry.jobId === h.jobs[0].id)).toBe(true);
});

test("実際の独立対局親は小さい固定workで同じ棋譜を返す", async () => {
  const options = argumentsFor([
    "--work",
    "1",
    "--seed",
    "9430101",
    "--seeds",
    "1",
    "--restrictions",
    "off",
    "--seats",
    "south",
    "--profiles",
    "study,baseline",
    "--concurrency",
    "2",
    "--max-plies",
    "1",
  ]);
  const opponent = await loadPlayer("frozen");
  const config: StrengthProcessConfig = {
    options,
    contractHash: "real-small-fixed-work",
    runnerVersion: strengthRunnerVersion,
    code: strengthCodeIdentity(),
    opponentId: opponent.id,
    opponentMetadata: opponent.metadata,
  };
  const pool = createStrengthProcessPool({ ...config, concurrency: 2 });
  try {
    const direct = createStrengthGameRunner(options, opponent, null);
    const jobs = createStrengthJobs(options);
    const results = await Promise.all(jobs.map((job, lane) => pool.run(job, lane)));
    for (const [lane, job] of jobs.entries()) {
      const expected = await direct(job, lane, () => false);
      expect(results[lane].replay).toEqual(expected.replay);
      expect(results[lane].sample.finalStateHash).toBe(expected.sample.finalStateHash);
      expect(results[lane].sample.trajectoryHash).toBe(expected.sample.trajectoryHash);
      expect(hashJson(results[lane].candidateDepths)).toBe(hashJson(expected.candidateDepths));
    }
  } finally {
    await pool.close();
    opponent.dispose();
  }
}, 15000);
