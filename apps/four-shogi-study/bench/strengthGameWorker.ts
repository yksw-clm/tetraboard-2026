import { loadPlayer, type Player } from "../../../packages/four-shogi/bench/baseline";
import { hashJson } from "../../../packages/four-shogi/bench/singlesMeasurement";
import { createStudySearchRuntime, type StudySearchRuntime } from "../src/search/runtime";
import { createStrengthGameRunner, strengthCodeIdentity, strengthRunnerVersion } from "./strength";
import type { StrengthParentCommand, StrengthParentMessage } from "./strengthProcessProtocol";

type Initialization = Extract<StrengthParentCommand, { type: "init" }>;
let initialization: Initialization | null = null;
let initializing: Promise<void> | null = null;
let opponent: Player | null = null;
let runtime: StudySearchRuntime | null = null;
let activeSearchId: string | null = null;
let gameRunner: ReturnType<typeof createStrengthGameRunner> | null = null;
let running: Promise<void> | null = null;
let stopped = false;
let closing: Promise<void> | null = null;

function send(message: StrengthParentMessage) {
  if (process.connected) process.send?.(message);
}
function envelope() {
  if (!initialization) throw new Error("対局親を初期化してください");
  return {
    runId: initialization.runId,
    generation: initialization.generation,
    lane: initialization.lane,
    contractHash: initialization.config.contractHash,
  };
}
function stop() {
  stopped = true;
  if (activeSearchId) void runtime?.cancel(activeSearchId).catch(() => {});
}
function close(): Promise<void> {
  if (closing) return closing;
  stop();
  closing = (async () => {
    await initializing?.catch(() => {});
    await running?.catch(() => {});
    try {
      await runtime?.close();
    } finally {
      opponent?.dispose();
      if (initialization) send({ type: "closed", ...envelope() });
      if (process.connected) process.disconnect();
    }
  })();
  void closing.then(
    () => process.exit(0),
    () => process.exit(1),
  );
  return closing;
}
function error(message: string, jobId: string | null = null) {
  if (initialization) send({ type: "error", ...envelope(), jobId, message });
  else console.error(message);
  void close();
}

async function initialize(message: Initialization) {
  initialization = message;
  if (message.config.runnerVersion !== strengthRunnerVersion)
    throw new Error("対局親のrunner版が一致しません");
  const code = strengthCodeIdentity();
  if (hashJson(code) !== hashJson(message.config.code))
    throw new Error("対局親のコードまたはHEADが一致しません");
  opponent = await loadPlayer("frozen");
  if (
    opponent.id !== message.config.opponentId ||
    hashJson(opponent.metadata) !== hashJson(message.config.opponentMetadata)
  )
    throw new Error("対局親の固定Lv2が一致しません");
  const options = message.config.options;
  if ("timeMs" in options.budget) {
    const base = createStudySearchRuntime({ threads: options.threads, memoryMb: options.memoryMb });
    runtime = {
      ...base,
      async start(input, settings, callback) {
        const id = await base.start(input, settings, callback);
        activeSearchId = id;
        if (stopped) await base.cancel(id);
        return id;
      },
    };
  }
  gameRunner = createStrengthGameRunner(options, opponent, runtime);
  if (!closing)
    send({
      type: "ready",
      ...envelope(),
      code,
      opponentId: opponent.id,
      opponentMetadata: opponent.metadata,
    });
}

process.on("message", (raw: unknown) => {
  if (!raw || typeof raw !== "object") {
    error("対局親の操作形式が不正です");
    return;
  }
  const message = raw as StrengthParentCommand;
  if (message.type === "init") {
    if (initialization) {
      error("対局親を二重に初期化できません");
      return;
    }
    initializing = initialize(message);
    void initializing.catch((cause: unknown) =>
      error(cause instanceof Error ? cause.message : String(cause)),
    );
    return;
  }
  if (
    !initialization ||
    message.runId !== initialization.runId ||
    message.generation !== initialization.generation
  )
    return;
  if (message.type === "stop") {
    stop();
    return;
  }
  if (message.type === "close") {
    void close();
    return;
  }
  if (message.type !== "run" || !gameRunner || running || stopped || closing) {
    error("対局親はこのjobを受け付けられません");
    return;
  }
  const job = message.job;
  const options = initialization.config.options;
  if (
    job.seed < options.seed ||
    job.seed >= options.seed + options.seeds ||
    !options.seats.includes(job.seat) ||
    !options.profiles.includes(job.profile) ||
    !options.restrictions.includes(job.restricted)
  ) {
    error("対局jobの開始条件が一致しません", job.id);
    return;
  }
  const play = gameRunner;
  running = (async () => {
    try {
      const game = await play(job, initialization!.lane, () => stopped);
      send({ type: "result", ...envelope(), jobId: job.id, game });
    } catch (cause) {
      error(cause instanceof Error ? cause.message : String(cause), job.id);
    } finally {
      activeSearchId = null;
      running = null;
    }
  })();
});
process.on("disconnect", () => {
  void close();
});
process.on("SIGTERM", () => {
  void close();
});
process.on("SIGINT", () => {
  void close();
});
