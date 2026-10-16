import { spawn, type ChildProcess } from "node:child_process";
import type { AiJobRequest } from "@tetraboard/protocol/four-shogi-ai";
import type { ServiceConfig } from "./config";
import type { Computed, JobExecutor } from "./jobs";
import type { ComputeSettings } from "./compute";

type Slot = {
  child: ChildProcess;
  ready: boolean;
  expectedExit: boolean;
  modelPid: number | null;
  active: { id: string; done: (value: Computed | null, error?: string) => void } | null;
};
export class ProcessPool implements JobExecutor {
  private slots: (Slot | null)[];
  private stopped = false;
  private failures: number[];
  constructor(
    private config: ServiceConfig,
    private entry = new URL("./compute.ts", import.meta.url).pathname,
    private log: (entry: object) => void = () => {},
  ) {
    this.slots = Array(config.workers).fill(null);
    this.failures = Array(config.workers).fill(0);
  }
  async start() {
    await Promise.all(this.slots.map((_, i) => this.spawnSlot(i)));
  }
  private spawnSlot(index: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.stopped) return reject(new Error("pool_stopped"));
      const child = spawn(process.execPath, ["--no-env-file", this.entry], {
        detached: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        env: {
          PATH: process.env.PATH,
          TMPDIR: process.env.TMPDIR,
          PYTHONUNBUFFERED: "1",
          PYTHONDONTWRITEBYTECODE: "1",
          OMP_NUM_THREADS: "1",
          MKL_NUM_THREADS: "1",
          OPENBLAS_NUM_THREADS: "1",
        },
      });
      const slot: Slot = { child, ready: false, expectedExit: false, modelPid: null, active: null };
      this.slots[index] = slot;
      let initialized = false;
      const timer = setTimeout(() => {
        this.kill(index);
        reject(new Error("worker_startup_timeout"));
      }, this.config.startupTimeoutMs);
      child.on("message", (raw: unknown) => {
        if (this.slots[index] !== slot) return;
        const message = raw as {
          type: string;
          modelId: string | null;
          modelPid: number | null;
          jobId: string;
          value: Computed | null;
          error?: string;
        };
        if (message.type === "ready") {
          if (message.modelId !== this.config.modelId) {
            this.kill(index);
            return reject(new Error("model_mismatch"));
          }
          initialized = true;
          slot.ready = true;
          slot.modelPid = message.modelPid;
          this.log({
            event: "compute_ready",
            slot: index,
            pid: child.pid,
            modelPid: slot.modelPid,
            modelId: message.modelId,
          });
          clearTimeout(timer);
          resolve();
        } else if (message.type === "startup_failed") {
          clearTimeout(timer);
          reject(new Error("model_unavailable"));
        } else if (message.type === "done" && slot.active?.id === message.jobId) {
          const done = slot.active.done;
          slot.active = null;
          this.failures[index] = 0;
          done(message.value, message.error);
        }
      });
      child.once("error", () => {
        clearTimeout(timer);
        reject(new Error("worker_spawn_failed"));
      });
      child.once("exit", () => {
        // 計算Bunが先に終了した場合も、同じ群のPythonを残しません。
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {}
        clearTimeout(timer);
        slot.ready = false;
        this.log({
          event: "compute_exited",
          slot: index,
          pid: child.pid,
          expected: this.stopped || slot.expectedExit,
        });
        const active = slot.active;
        slot.active = null;
        if (this.slots[index] === slot) this.slots[index] = null;
        active?.done(null, "worker_exited");
        if (!initialized) reject(new Error("worker_startup_failed"));
        if (!this.stopped && initialized && (slot.expectedExit || ++this.failures[index] <= 3))
          void this.spawnSlot(index).catch(() => {});
      });
      const settings: ComputeSettings = {
        codeVersion: this.config.codeVersion,
        python: this.config.python,
        modelDirectory: this.config.modelDirectory,
        modelId: this.config.modelId,
      };
      child.send({ type: "init", settings });
    });
  }
  ready(index: number) {
    return this.slots[index]?.ready ?? false;
  }
  run(
    index: number,
    jobId: string,
    request: AiJobRequest,
    budgetMs: number,
    done: (value: Computed | null, error?: string) => void,
  ) {
    const slot = this.slots[index];
    if (!slot?.ready || slot.active) throw new Error("worker_unavailable");
    slot.active = { id: jobId, done };
    slot.child.send({ type: "run", jobId, request, budgetMs }, (error) => {
      if (error && slot.active?.id === jobId) {
        slot.active = null;
        done(null, "worker_disconnected");
      }
    });
  }
  cancel(index: number, jobId: string) {
    const slot = this.slots[index];
    if (slot?.active?.id === jobId && slot.child.connected)
      slot.child.send({ type: "cancel", jobId }, () => {});
  }
  kill(index: number) {
    const slot = this.slots[index];
    if (!slot) return;
    slot.ready = false;
    slot.expectedExit = true;
    try {
      if (slot.child.pid) process.kill(-slot.child.pid, "SIGKILL");
    } catch {
      slot.child.kill("SIGKILL");
    }
  }
  pids() {
    return this.slots.flatMap((s) =>
      s ? [s.child.pid, s.modelPid].filter((p): p is number => typeof p === "number") : [],
    );
  }
  async close() {
    this.stopped = true;
    await Promise.all(
      this.slots.map(
        (slot, index) =>
          new Promise<void>((resolve) => {
            if (!slot || slot.child.exitCode !== null) return resolve();
            const timer = setTimeout(() => this.kill(index), this.config.cancelGraceMs);
            slot.child.once("exit", () => {
              clearTimeout(timer);
              resolve();
            });
            if (slot.child.connected) slot.child.send({ type: "stop" }, () => {});
            else this.kill(index);
          }),
      ),
    );
  }
}
