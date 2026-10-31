import { spawn } from "node:child_process";
import { openSync, closeSync, statfsSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { loadavg } from "node:os";
import { atomicJson } from "./nightlyStore";

export type ResourceLimits = {
  maxRunMs: number;
  maxRssBytes: number;
  hardRssBytes: number;
  minFreeBytes: number;
};
export type StageUsage = {
  systemPressureLevel?: number | null;
  thermalStatus?: string;
  peakLoad1?: number;
  name: string;
  startedAt: string;
  elapsedMs: number;
  exitCode: number | null;
  signal: string | null;
  stopReason: string | null;
  peakRssBytes: number;
  sampledCpuSeconds: number;
  peakProcesses: number;
  freeBytes: number;
  rssSamplingMs: number;
};
export class NightlySupervisor {
  private readonly deadline: number;
  private stopped: string | null = null;
  private active: number | null = null;
  readonly records: StageUsage[] = [];
  constructor(
    readonly limits: ResourceLimits,
    readonly root: string,
    readonly signal?: AbortSignal,
    private readonly observations: { readPressure?: () => number | null } = {},
  ) {
    this.deadline = Date.now() + limits.maxRunMs;
  }
  remaining() {
    return Math.max(0, this.deadline - Date.now());
  }
  disk() {
    const s = statfsSync(this.root);
    const free = s.bavail * s.bsize;
    if (free < this.limits.minFreeBytes) throw new Error("disk_limit: 空き容量が不足しています");
    return free;
  }
  stop(reason: string) {
    this.stopped ??= reason;
    if (this.active !== null) this.kill(this.active, "SIGTERM");
  }
  private kill(pid: number, signal: NodeJS.Signals) {
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        const group = Bun.spawnSync(["ps", "-axo", "pid=,pgid=,uid=,stat="]);
        if (group.exitCode !== 0) throw error;
        const entries = group.stdout
          .toString()
          .trim()
          .split("\n")
          .map((line) => line.trim().split(/\s+/))
          .filter((parts) => Number(parts[1]) === pid);
        // macOSではwatchdogが先に止めた終了待ちの群へのsignalがEPERMになることがある。
        if (!entries.length || entries.every((parts) => parts[3].startsWith("Z"))) return;
        throw new Error(
          `工程の停止権限を確認できません: owner=${process.pid} child=${pid} state=${JSON.stringify(entries)} ${String(error)}`,
        );
      }
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  async run(name: string, command: string[], log: string, report: string): Promise<StageUsage> {
    if (this.signal?.aborted || this.stopped || !this.remaining())
      throw new Error(this.stopped ?? "nightlyの期限/取消です");
    const free = this.disk(),
      started = performance.now(),
      fd = openSync(log, "a", 0o600);
    const child = spawn(command[0], command.slice(1), {
      detached: true,
      stdio: ["ignore", fd, fd],
      env: {
        ...process.env,
        OMP_NUM_THREADS: "1",
        MKL_NUM_THREADS: "1",
        VECLIB_MAXIMUM_THREADS: "1",
      },
    });
    closeSync(fd);
    if (!child.pid) throw new Error("工程の子プロセスを起動できません");
    const pid = child.pid;
    this.active = pid;
    const watchdog = Bun.spawn({
      cmd: [
        process.execPath,
        fileURLToPath(new URL("./nightlyWatchdog.ts", import.meta.url)),
        String(process.pid),
        String(pid),
        String(this.deadline),
      ],
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    const usage: StageUsage = {
      systemPressureLevel: null,
      peakLoad1: loadavg()[0],
      name,
      startedAt: new Date().toISOString(),
      elapsedMs: 0,
      exitCode: null,
      signal: null,
      stopReason: null,
      peakRssBytes: 0,
      sampledCpuSeconds: 0,
      peakProcesses: 0,
      freeBytes: free,
      rssSamplingMs: 500,
    };
    const cpuMax = new Map<number, number>();
    let sampled = 0;
    if (process.platform === "darwin") {
      const thermal = Bun.spawnSync(["pmset", "-g", "therm"]);
      usage.thermalStatus = (thermal.stdout.toString() + thermal.stderr.toString()).slice(0, 2000);
    }
    let stoppedAt: number | null = null;
    const terminate = (reason: string, hard = false) => {
      usage.stopReason ??= reason;
      stoppedAt ??= Date.now();
      this.kill(pid, hard ? "SIGKILL" : "SIGTERM");
    };
    const cancel = () => terminate("cancelled");
    this.signal?.addEventListener("abort", cancel, { once: true });
    const monitor = () => {
      try {
        const ps = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,rss=,time=,comm="]);
        if (ps.exitCode !== 0) throw new Error("子孫RSS/CPUを観測できません");
        const entries = ps.stdout
          .toString()
          .trim()
          .split("\n")
          .flatMap((line) => {
            const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d:.-]+)\s+(.+)$/.exec(line);
            if (!match) return [];
            const parts = match[4].split(":").map(Number);
            const cpu =
              parts.length === 2
                ? parts[0] * 60 + parts[1]
                : parts[0] * 3600 + parts[1] * 60 + parts[2];
            return [
              {
                pid: Number(match[1]),
                ppid: Number(match[2]),
                rss: Number(match[3]) * 1024,
                cpu,
                program: basename(match[5]),
              },
            ];
          });
        const descendants = new Set([pid]);
        for (let i = 0; i < entries.length; i++) {
          let changed = false;
          for (const e of entries)
            if (descendants.has(e.ppid) && !descendants.has(e.pid)) {
              descendants.add(e.pid);
              changed = true;
            }
          if (!changed) break;
        }
        const group = entries.filter((e) => descendants.has(e.pid) || e.pid === watchdog.pid);
        let rss = process.memoryUsage().rss;
        for (const e of group) {
          rss += e.rss;
          cpuMax.set(e.pid, Math.max(cpuMax.get(e.pid) ?? 0, e.cpu));
        }
        usage.peakRssBytes = Math.max(usage.peakRssBytes, rss);
        usage.peakProcesses = Math.max(usage.peakProcesses, group.length);
        usage.peakLoad1 = Math.max(usage.peakLoad1 ?? 0, loadavg()[0]);
        if (sampled++ % 10 === 0) {
          let level = this.observations.readPressure?.() ?? null;
          if (!this.observations.readPressure && process.platform === "darwin") {
            const pressure = Bun.spawnSync(["sysctl", "-n", "kern.memorystatus_vm_pressure_level"]);
            if (pressure.exitCode === 0) level = Number(pressure.stdout.toString().trim());
          }
          if (level !== null && [1, 2, 4].includes(level)) {
            usage.systemPressureLevel = Math.max(usage.systemPressureLevel ?? 0, level);
            if (level >= 2) terminate("system_memory_pressure", level >= 4);
          }
        }
        if (rss > this.limits.hardRssBytes) terminate("hard_memory_limit", true);
        else if (rss > this.limits.maxRssBytes) terminate("memory_limit");
        if (this.signal?.aborted || this.stopped) terminate(this.stopped ?? "cancelled");
        if (!this.remaining()) terminate("time_limit");
        this.disk();
        if (stoppedAt !== null && Date.now() - stoppedAt >= 2000)
          terminate(usage.stopReason ?? "cancelled", true);
      } catch (error) {
        terminate(String(error), true);
      }
    };
    const timer = setInterval(monitor, 500);
    monitor();
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => {
          usage.exitCode = code;
          usage.signal = signal;
          resolve();
        });
      });
      if (!this.remaining()) usage.stopReason ??= "time_limit";
      if (this.signal?.aborted) usage.stopReason ??= "cancelled";
    } finally {
      clearInterval(timer);
      this.signal?.removeEventListener("abort", cancel);
      this.kill(pid, "SIGKILL");
      watchdog.kill();
      await watchdog.exited;
      this.active = null;
      usage.elapsedMs = performance.now() - started;
      usage.sampledCpuSeconds = [...cpuMax.values()].reduce((a, b) => a + b, 0);
      this.records.push(usage);
      atomicJson(report, usage);
    }
    if (usage.exitCode !== 0 || usage.stopReason)
      throw new Error(`${name}: ${usage.stopReason ?? usage.signal ?? usage.exitCode}`);
    return usage;
  }
}
