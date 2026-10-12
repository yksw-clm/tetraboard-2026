import { availableParallelism } from "node:os";
import { statfsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sides } from "@tetraboard/four-shogi";
import { lv3Weights } from "@tetraboard/four-shogi/lv3";
import {
  aiModelSchema,
  aiStatusSchema,
  type AiModel,
  type AiProfile,
  type AiRun,
  type AiStatus,
} from "@tetraboard/protocol/shogi-ai";
import { seededRandom } from "../../../packages/four-shogi/bench/measurement";
import { AiStore, profiles, sourceIdentity, type Task } from "./store";
import { metrics, pairedInterval } from "./statistics";
export type TrainingOptions = {
  seconds: number;
  workers: number;
  seeds: number;
  maxPlies: number;
  work: number;
  minFreeBytes: number;
};
export const defaultTrainingOptions: TrainingOptions = {
  seconds: 86400,
  workers: Math.min(5, Math.max(1, availableParallelism() - 1)),
  seeds: 8,
  maxPlies: 800,
  work: 16384,
  minFreeBytes: 20 * 1024 ** 3,
};
export function parseOptions(args: string[]): TrainingOptions {
  const options = { ...defaultTrainingOptions };
  const keys: Record<string, keyof TrainingOptions> = {
    "--seconds": "seconds",
    "--workers": "workers",
    "--seeds": "seeds",
    "--max-plies": "maxPlies",
    "--work": "work",
    "--min-free-bytes": "minFreeBytes",
  };
  for (let i = 0; i < args.length; i += 2) {
    const key = keys[args[i]],
      n = Number(args[i + 1]);
    if (!key || !Number.isSafeInteger(n) || n < 1) throw new Error("Invalid training options");
    options[key] = n;
  }
  if (
    options.work > 262144 ||
    options.work < 128 ||
    options.workers > 5 ||
    options.seeds > 100 ||
    options.maxPlies > 800 ||
    options.seconds > 86400
  )
    throw new Error("Training options out of range");
  return options;
}
export function mutateModel(
  parent: AiModel,
  generation: number,
  variant: number,
  identity: Awaited<ReturnType<typeof sourceIdentity>>,
): AiModel {
  const random = seededRandom(
    generation * 97 + variant * 1009 + (parent.profileId === "singles-restricted" ? 0 : 1),
  );
  const bounds: Record<keyof typeof lv3Weights, [number, number]> = {
    undefended: [0.5, 3],
    exchange: [0.3, 2],
    kingRing: [10, 120],
    check: [0, 200],
    mobility: [0, 10],
    advancement: [0, 20],
    shelter: [0, 50],
    survival: [3000, 7000],
  };
  const weights = { ...parent.weights };
  for (const key of Object.keys(weights) as (keyof typeof weights)[])
    weights[key] = Math.min(
      bounds[key][1],
      Math.max(
        bounds[key][0],
        weights[key] * (0.85 + random() * 0.3) + (weights[key] === 0 ? random() : 0),
      ),
    );
  return aiModelSchema.parse({
    ...parent,
    ...identity,
    id: `${parent.profileId}-g${generation}-v${variant}-${identity.sourceHash.slice(0, 10)}`,
    generation,
    parentId: parent.id,
    weights,
    createdAt: Date.now(),
  });
}
export class Trainer {
  private readonly children = new Map<
    string,
    { process: ReturnType<typeof Bun.spawn>; task: Task }
  >();
  private readonly errors: string[] = [];
  private readonly retries = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopping = false;
  private busy = false;
  private nextProfile = 0;
  private identity: Awaited<ReturnType<typeof sourceIdentity>> | null = null;
  private endsAt = 0;
  private gate: ReturnType<typeof Bun.spawn> | null = null;
  private stage: AiStatus["learning"]["stage"] = "initialising";
  constructor(
    readonly store: AiStore,
    readonly options: TrainingOptions,
  ) {}
  async start() {
    this.identity = await sourceIdentity();
    const config = {
      seeds: this.options.seeds,
      maxPlies: this.options.maxPlies,
      work: this.options.work,
    };
    const savedConfig = this.store.get<typeof config>("config");
    if (savedConfig && JSON.stringify(savedConfig) !== JSON.stringify(config))
      throw new Error("Resume with the original seeds/max-plies/work options");
    this.store.set("config", config);
    for (const profile of profiles) {
      if (!this.store.get<string>(`champion:${profile}`)) {
        const model = aiModelSchema.parse({
          ...this.identity,
          schemaVersion: 1,
          id: `${profile}-initial-${this.identity.sourceHash.slice(0, 10)}`,
          profileId: profile,
          generation: 0,
          parentId: null,
          createdAt: Date.now(),
          weights: lv3Weights,
          maxWork: this.options.work,
        });
        await this.store.saveModel(model);
        this.store.set(`initial:${profile}`, model.id);
        this.store.set(`champion:${profile}`, model.id);
      }
      const champion = this.store.model(this.store.get<string>(`champion:${profile}`)!);
      if (
        champion.sourceHash !== this.identity.sourceHash ||
        champion.maxWork !== this.options.work
      )
        throw new Error(
          "Existing data belongs to another engine/budget. Export it and use a new AI_DATA_DIR.",
        );
    }
    this.store.set("startedAt", this.store.get<number>("startedAt") ?? Date.now());
    this.endsAt = this.store.get<number>("endsAt") ?? Date.now() + this.options.seconds * 1000;
    this.store.set("endsAt", this.endsAt);
    this.stage = "selfplay";
    this.stopping = false;
    this.timer = setInterval(() => {
      this.snapshot();
      void this.tick();
    }, 1000);
    await this.tick();
    this.snapshot();
  }
  private async generation(profile: AiProfile) {
    const parent = this.store.model(this.store.get<string>(`champion:${profile}`)!);
    const latest = this.store.latest(profile);
    const generation = (latest?.generation ?? 0) + 1;
    const id = `${String(Date.now()).padStart(16, "0")}-${profile}-g${generation}`;
    const candidates = [
      mutateModel(parent, generation, 1, this.identity!),
      mutateModel(parent, generation, 2, this.identity!),
    ];
    for (const candidate of candidates) await this.store.saveModel(candidate);
    const run: AiRun = {
      id,
      profileId: profile,
      generation,
      stage: "selfplay",
      modelId: candidates[0].id,
      parentId: parent.id,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      completedGames: 0,
      plannedGames: this.options.seeds * 4 * 3,
      accepted: false,
      differenceInterval: null,
      metrics: metrics([]),
      error: null,
    };
    this.store.saveRun(run);
    this.store.set(
      `candidates:${id}`,
      candidates.map((m) => m.id),
    );
    this.schedule(run, [parent.id, ...candidates.map((m) => m.id)], "tune");
  }
  private schedule(run: AiRun, models: string[], pool: "tune" | "test") {
    for (let series = 0; series < this.options.seeds; series++)
      for (const [rotation, seat] of sides.entries())
        for (const [variant, modelId] of models.entries()) {
          const seed =
            (pool === "tune" ? 100000 : 1000000000) +
            run.generation * 1000 +
            series +
            (run.profileId === "singles-restricted" ? 0 : 100000000);
          // 開始系列と席は共有し、世代ごとにLv2・初期Lv3・親を相手に交代します。
          const opponentId = [
            "lv2",
            this.store.get<string>(`initial:${run.profileId}`)!,
            run.parentId,
          ][series % 3];
          const task: Task = {
            id: `${run.id}-${pool}-${series}-${rotation}-${variant}`,
            runId: run.id,
            profileId: run.profileId,
            modelId,
            opponentId,
            seed,
            seat,
            maxPlies: this.options.maxPlies,
            pool,
          };
          this.store.addTask(task);
        }
  }
  private async advance(run: AiRun) {
    const candidates = this.store.get<string[]>(`candidates:${run.id}`)!;
    const pool = run.stage === "evaluating" ? "test" : "tune";
    const baseline = this.store.samples(run.id, run.parentId, pool);
    const samples = candidates.map((id) => this.store.samples(run.id, id, pool));
    run.completedGames = baseline.length + samples.reduce((n, s) => n + s.length, 0);
    run.updatedAt = Date.now();
    const best =
      samples[1]?.length && (metrics(samples[1]).reward ?? 0) > (metrics(samples[0]).reward ?? 0)
        ? 1
        : 0;
    run.modelId = candidates[best];
    run.metrics = metrics(samples[best]);
    run.differenceInterval = pairedInterval(samples[best], baseline);
    if (run.completedGames < run.plannedGames) {
      this.store.saveRun(run);
      return;
    }
    if (run.stage === "selfplay") {
      const selected = run.modelId;
      this.store.set(`candidates:${run.id}`, [selected]);
      run.stage = "evaluating";
      run.plannedGames = this.options.seeds * 4 * 2;
      run.completedGames = 0;
      run.metrics = metrics([]);
      run.differenceInterval = null;
      this.schedule(run, [run.parentId, selected], "test");
      this.store.saveRun(run);
      return;
    }
    const parentMetrics = metrics(baseline);
    const n = run.metrics.games;
    run.accepted =
      !!run.differenceInterval &&
      run.differenceInterval[0] > 0 &&
      n >= 32 &&
      run.metrics.unfinished / n <=
        parentMetrics.unfinished / Math.max(1, parentMetrics.games) + 0.05 &&
      run.metrics.draws / n <= parentMetrics.draws / Math.max(1, parentMetrics.games) + 0.05;
    if (run.accepted) {
      this.gate = Bun.spawn(
        [process.execPath, join(import.meta.dir, "tacticalGateWorker.ts"), run.modelId],
        {
          env: { ...process.env, AI_DATA_DIR: this.store.directory },
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      const timer = setTimeout(() => this.gate?.kill("SIGKILL"), 60000);
      const code = await this.gate.exited;
      clearTimeout(timer);
      this.gate = null;
      run.accepted = code === 0 && !this.stopping;
      if (!run.accepted) run.error = "既知の戦術局面の回帰確認を通過しませんでした。";
    }
    run.stage = "ready";
    // 試用中は学習の親だけを更新します。TetraBoardの実対局への配布・採用は行いません。
    if (run.accepted) this.store.set(`champion:${run.profileId}`, run.modelId);
    this.store.saveRun(run);
    this.store.set("checkpointAt", Date.now());
  }
  private async tick() {
    if (this.busy || this.stopping) return;
    this.busy = true;
    try {
      if (Date.now() >= this.endsAt) {
        await this.stop();
        return;
      }
      const disk = statfsSync(this.store.directory);
      if (disk.bavail * disk.bsize < this.options.minFreeBytes) {
        this.errors.push("空きディスク容量が下限に達したため学習を停止しました。");
        await this.stop();
        return;
      }
      for (const profile of profiles) {
        const run = this.store.latest(profile);
        if (!run || run.stage === "ready") await this.generation(profile);
        else if (run.stage === "failed") {
          this.stage = "failed";
          await this.stop();
          return;
        } else await this.advance(run);
      }
      const pending = this.store.pending().filter((t) => !this.children.has(t.id));
      while (this.children.size < this.options.workers && pending.length) {
        const preferred = profiles[this.nextProfile++ % 2];
        const index = pending.findIndex((t) => t.profileId === preferred);
        const task = pending.splice(index < 0 ? 0 : index, 1)[0];
        const child = Bun.spawn(
          [process.execPath, join(import.meta.dir, "matchWorker.ts"), task.id],
          {
            env: { ...process.env, AI_DATA_DIR: this.store.directory },
            stdout: "ignore",
            stderr: "ignore",
          },
        );
        this.children.set(task.id, { process: child, task });
        void child.exited.then((code) => {
          this.children.delete(task.id);
          if (code !== 0 && !this.stopping) {
            const attempts = (this.retries.get(task.id) ?? 0) + 1;
            this.retries.set(task.id, attempts);
            this.errors.push(
              `自己対局プロセスが終了しました（code=${code}、再試行${attempts}/3）。`,
            );
            if (attempts >= 3) {
              const run = this.store.latest(task.profileId);
              if (run) {
                run.stage = "failed";
                run.error = "自己対局が繰り返し失敗しました。";
                this.store.saveRun(run);
              }
            }
          }
          this.snapshot();
          void this.tick();
        });
      }
      this.stage = profiles.some((p) => this.store.latest(p)?.stage === "evaluating")
        ? "evaluating"
        : "selfplay";
    } catch {
      this.errors.push("学習制御に失敗しました。設定と保存データを確認してください。");
      this.stage = "failed";
      await this.stop();
    } finally {
      this.busy = false;
    }
  }
  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.gate?.kill("SIGKILL");
    for (const child of this.children.values()) child.process.kill("SIGTERM");
    const kill = setTimeout(() => {
      for (const child of this.children.values()) child.process.kill("SIGKILL");
    }, 5000);
    await Promise.all([...this.children.values()].map((c) => c.process.exited));
    clearTimeout(kill);
    if (this.stage !== "failed") this.stage = "stopped";
    this.store.set("checkpointAt", Date.now());
    this.snapshot();
  }
  snapshot(): AiStatus {
    const now = Date.now(),
      games = this.store.db
        .query<{ n: number }, []>("SELECT COUNT(*) n FROM tasks WHERE result IS NOT NULL")
        .get()!.n;
    let memoryLimitBytes: number | null = null;
    try {
      const n = Number(readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim());
      if (Number.isSafeInteger(n) && n > 0) memoryLimitBytes = n;
    } catch {
      /* ローカル環境ではcgroupを使いません。 */
    }
    const disk = statfsSync(this.store.directory),
      usage = process.cpuUsage();
    let memoryBytes = process.memoryUsage().rss,
      cpuSeconds = (usage.user + usage.system) / 1000000,
      scope: "controller" | "container" = "controller";
    try {
      memoryBytes = Number(readFileSync("/sys/fs/cgroup/memory.current", "utf8").trim());
      const cpu = readFileSync("/sys/fs/cgroup/cpu.stat", "utf8").match(/^usage_usec (\d+)$/m);
      if (cpu) cpuSeconds = Number(cpu[1]) / 1000000;
      scope = "container";
    } catch {
      /* 非Linuxでは制御プロセスの測定値を表示します。 */
    }
    const snapshot = aiStatusSchema.parse({
      schemaVersion: 1,
      generatedAt: now,
      heartbeatAt: now,
      startedAt: this.store.get("startedAt") ?? now,
      learningEndsAt: this.endsAt || null,
      profiles: profiles.map((profileId) => {
        const champion = this.store.model(this.store.get<string>(`champion:${profileId}`)!);
        const run = this.store.latest(profileId);
        return { profileId, champion, candidate: run ? this.store.model(run.modelId) : null, run };
      }),
      learning: {
        stage: this.stage,
        games,
        gamesPerHour:
          (games * 3600000) / Math.max(1, now - (this.store.get<number>("startedAt") ?? now)),
        checkpointAt: this.store.get("checkpointAt"),
        activeGames: [...this.children.values()].slice(0, 5).map((c) => ({
          id: c.task.id,
          profileId: c.task.profileId,
          ply: this.store.task(c.task.id).ply,
        })),
      },
      resources: {
        memoryBytes,
        scope,
        memoryLimitBytes,
        cpuSeconds,
        diskFreeBytes: disk.bavail * disk.bsize,
      },
      recentErrors: this.errors.slice(-10),
    });
    this.store.set("status", snapshot);
    return snapshot;
  }
}
