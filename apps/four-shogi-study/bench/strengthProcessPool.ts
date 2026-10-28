import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { hashJson } from "../../../packages/four-shogi/bench/singlesMeasurement";
import type { RecordedGame, StrengthJob } from "./strength";
import type {
  StrengthParentCommand,
  StrengthParentFailure,
  StrengthParentMessage,
  StrengthProcessConfig,
} from "./strengthProcessProtocol";

type ActiveGame = {
  job: StrengthJob;
  resolve: (game: RecordedGame) => void;
  reject: (error: Error) => void;
};
type Slot = {
  lane: number;
  generation: string;
  child: ChildProcess | null;
  pid: number | null;
  ready: Promise<void> | null;
  readyResolve: () => void;
  readyReject: (error: Error) => void;
  exit: Promise<void>;
  exitResolve: () => void;
  active: ActiveGame | null;
  closing: boolean;
  cleanup: Promise<void> | null;
};
export type StrengthProcessPoolOptions = StrengthProcessConfig & {
  concurrency: number;
  workerScript?: URL;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
};
export class StrengthProcessStoppedError extends Error {}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
async function waitExit(exit: Promise<void>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      exit,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
function groupAlive(pid: number) {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}
function signalGroup(slot: Slot, signal: NodeJS.Signals) {
  if (!slot.pid) return;
  try {
    process.kill(process.platform === "win32" ? slot.pid : -slot.pid, signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}
async function waitGroup(slot: Slot, timeoutMs: number) {
  const deadline = performance.now() + timeoutMs;
  while (slot.pid && groupAlive(slot.pid) && performance.now() < deadline) await delay(10);
  return slot.pid === null || !groupAlive(slot.pid);
}

/** 対局親のイベントループを分け、別局の同期Lv2から探索の期限とbarrierを隔離します。 */
export function createStrengthProcessPool(config: StrengthProcessPoolOptions) {
  if (!Number.isSafeInteger(config.concurrency) || config.concurrency < 1 || config.concurrency > 2)
    throw new Error("対局親は1〜2プロセスです");
  const runId = crypto.randomUUID();
  const startupMs = config.startupTimeoutMs ?? 15000;
  const shutdownMs = config.shutdownTimeoutMs ?? 5000;
  const failures: StrengthParentFailure[] = [];
  const completed = new Map<string, string>();
  const reservedJobs = new Set<string>();
  const reservedLanes = new Set<number>();
  const slots: Slot[] = Array.from({ length: config.concurrency }, (_, lane) => {
    let exitResolve = () => {};
    const exit = new Promise<void>((resolve) => {
      exitResolve = resolve;
    });
    return {
      lane,
      generation: crypto.randomUUID(),
      child: null,
      pid: null,
      ready: null,
      readyResolve: () => {},
      readyReject: () => {},
      exit,
      exitResolve,
      active: null,
      closing: false,
      cleanup: null,
    };
  });
  let stopping = false;
  let closed = false;
  let forcedStop: ReturnType<typeof setTimeout> | null = null;
  let closing: Promise<void> | null = null;

  function send(slot: Slot, command: StrengthParentCommand) {
    if (!slot.child?.connected) return;
    slot.child.send(command, (error) => {
      if (error && !slot.closing && !closed)
        fail(slot, `対局親への送信に失敗しました: ${error.message}`);
    });
  }
  function remember(
    slot: Slot,
    message: string,
    kind: StrengthParentFailure["kind"] = "worker_exit",
    jobId = slot.active?.job.id ?? null,
  ) {
    const entry = { lane: slot.lane, jobId, message, kind, resolved: false };
    if (
      !failures.some(
        (value) =>
          value.lane === entry.lane &&
          value.jobId === entry.jobId &&
          value.message === entry.message,
      )
    )
      failures.push(entry);
  }
  function fail(
    slot: Slot,
    message: string,
    kind: StrengthParentFailure["kind"] = "protocol",
    jobId = slot.active?.job.id ?? null,
  ) {
    remember(slot, message, kind, jobId);
    const error = new Error(message);
    slot.readyReject(error);
    slot.active?.reject(error);
    slot.active = null;
    stop();
  }
  function stop() {
    if (stopping) return;
    stopping = true;
    for (const slot of slots) send(slot, { type: "stop", runId, generation: slot.generation });
    forcedStop = setTimeout(() => {
      forcedStop = null;
      void Promise.all(slots.map((slot) => cleanup(slot, 0))).catch(() => {});
    }, shutdownMs);
  }
  function cleanup(slot: Slot, graceMs = shutdownMs): Promise<void> {
    if (slot.cleanup) return slot.cleanup;
    slot.cleanup = (async () => {
      slot.closing = true;
      slot.readyReject(new StrengthProcessStoppedError("対局親の起動を停止しました"));
      send(slot, { type: "close", runId, generation: slot.generation });
      if (slot.child && slot.child.exitCode === null && slot.child.signalCode === null)
        await waitExit(slot.exit, graceMs);
      if (slot.pid && groupAlive(slot.pid)) signalGroup(slot, "SIGTERM");
      if (!(await waitGroup(slot, 500))) {
        signalGroup(slot, "SIGKILL");
        if (!(await waitGroup(slot, 1000))) {
          remember(slot, "対局親のプロセス群を終了できませんでした", "cleanup");
          throw new Error("対局親のプロセス群を終了できませんでした");
        }
      }
      if (slot.active) {
        remember(slot, "停止期限までに対局の途中棋譜を取得できませんでした", "cleanup");
        slot.active.reject(new Error("対局親を停止しました。未完了jobは再開時に再実行します"));
        slot.active = null;
      }
    })();
    return slot.cleanup;
  }
  function receive(slot: Slot, raw: unknown) {
    if (!raw || typeof raw !== "object") {
      fail(slot, "対局親の応答形式が不正です");
      return;
    }
    const message = raw as StrengthParentMessage;
    if (message.runId !== runId || message.generation !== slot.generation) return;
    if (message.lane !== slot.lane || message.contractHash !== config.contractHash) {
      fail(slot, "対局親のlane・測定条件が一致しません");
      return;
    }
    if (message.type === "ready") {
      if (
        hashJson(message.code) !== hashJson(config.code) ||
        message.opponentId !== config.opponentId ||
        hashJson(message.opponentMetadata) !== hashJson(config.opponentMetadata)
      ) {
        fail(slot, "対局親のコードまたは固定Lv2が一致しません");
        return;
      }
      slot.readyResolve();
      return;
    }
    if (message.type === "closed") return;
    if (message.type === "error") {
      fail(slot, message.message);
      return;
    }
    if (message.type !== "result") {
      fail(slot, "未知の対局親応答です");
      return;
    }
    const digest = hashJson(message.game);
    const prior = completed.get(message.jobId);
    if (prior !== undefined) {
      if (prior !== digest) {
        completed.delete(message.jobId);
        fail(slot, "同じjobの対局結果が変更されています", "result_conflict", message.jobId);
      }
      return;
    }
    const active = slot.active;
    const game = message.game;
    if (
      !active ||
      message.jobId !== active.job.id ||
      !game ||
      game.jobId !== active.job.id ||
      game.lane !== slot.lane ||
      game.profile !== active.job.profile ||
      game.restricted !== active.job.restricted ||
      game.sample?.matchId !== active.job.id ||
      game.sample.seed !== active.job.seed ||
      game.sample.seat !== active.job.seat ||
      typeof game.interrupted !== "boolean" ||
      !game.replay ||
      !Array.isArray(game.replay.events) ||
      game.replay.initial.threePlayerAttackProhibited !== active.job.restricted ||
      game.replay.events.length !== 12 + game.sample.moves
    ) {
      fail(slot, "対局親のjob・席・profile・棋譜が一致しません");
      return;
    }
    completed.set(message.jobId, digest);
    slot.active = null;
    active.resolve(game);
  }
  async function ready(slot: Slot) {
    if (slot.ready) return slot.ready;
    slot.ready = new Promise<void>((resolve, reject) => {
      slot.readyResolve = resolve;
      slot.readyReject = reject;
    });
    void slot.ready.catch(() => {});
    const worker = fileURLToPath(
      config.workerScript ?? new URL("./strengthGameWorker.ts", import.meta.url),
    );
    const child = spawn(process.execPath, ["--no-env-file", worker], {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      detached: process.platform !== "win32",
    });
    slot.child = child;
    slot.pid = child.pid ?? null;
    let stderr = "";
    child.stderr?.on("data", (value) => {
      stderr = `${stderr}${String(value)}`.slice(-8192);
    });
    const timer = setTimeout(
      () => fail(slot, "対局親の起動が期限を超えました", "worker_exit"),
      startupMs,
    );
    const clear = () => clearTimeout(timer);
    void slot.ready.then(clear, clear);
    child.on("message", (message) => {
      try {
        receive(slot, message);
      } catch (error) {
        fail(slot, `対局親の応答を検証できません: ${String(error)}`);
      }
    });
    child.on("error", (error) => {
      slot.exitResolve();
      if (!closed) fail(slot, `対局親を起動できません: ${error.message}`, "worker_exit");
    });
    child.on("exit", (code, signal) => {
      slot.exitResolve();
      if (slot.active || (!slot.closing && !closed))
        fail(slot, `対局親が終了しました（${signal ?? code}）${stderr}`, "worker_exit");
    });
    const { options, contractHash, runnerVersion, code, opponentId, opponentMetadata } = config;
    send(slot, {
      type: "init",
      runId,
      generation: slot.generation,
      lane: slot.lane,
      config: { options, contractHash, runnerVersion, code, opponentId, opponentMetadata },
    });
    return slot.ready;
  }
  return {
    async run(job: StrengthJob, lane: number): Promise<RecordedGame> {
      const slot = slots[lane];
      if (!slot || closed || stopping)
        throw new StrengthProcessStoppedError("対局親は新しいjobを受け付けません");
      if (
        slot.active ||
        reservedLanes.has(lane) ||
        reservedJobs.has(job.id) ||
        completed.has(job.id)
      )
        throw new Error("同じlaneまたはjobが実行済みです");
      reservedJobs.add(job.id);
      reservedLanes.add(lane);
      try {
        await ready(slot);
        if (closed || stopping || slot.active || !slot.child?.connected)
          throw new StrengthProcessStoppedError("対局親は停止中です");
        return await new Promise<RecordedGame>((resolve, reject) => {
          slot.active = { job, resolve, reject };
          send(slot, { type: "run", runId, generation: slot.generation, job });
        });
      } finally {
        reservedJobs.delete(job.id);
        reservedLanes.delete(lane);
      }
    },
    stop,
    failures() {
      return [...failures];
    },
    close(): Promise<void> {
      if (closing) return closing;
      closed = true;
      stop();
      if (forcedStop !== null) clearTimeout(forcedStop);
      forcedStop = null;
      closing = Promise.all(slots.map((slot) => cleanup(slot))).then(() => {});
      return closing;
    },
  };
}
