import { createStudyRootSearch } from "@tetraboard/four-shogi/study-search";
import { restoreStudyPosition } from "../domain/study";
import type { SearchCommand, SearchMessage, SearchWorkerTiming } from "./messages";
let current: {
  id: string;
  search: ReturnType<typeof createStudyRootSearch>;
  paused: boolean;
  barrier: boolean;
  depth: number;
  taskId?: number;
  partition: boolean;
  timing?: SearchWorkerTiming;
  reply?: Extract<SearchMessage, { type: "progress" }>["reply"];
  cpuStart?: ReturnType<typeof process.cpuUsage>;
  transport?: NonNullable<SearchWorkerTiming["transport"]>;
} | null = null;
let generation = 0;
let requestedId: string | null = null;
let requestedPaused = false;
let scheduled = false;
let lastSent = 0;
let activeSlice: {
  ownerId: string;
  started: number;
  cpu: ReturnType<typeof process.cpuUsage>;
} | null = null;
const send = (message: SearchMessage) => {
  if (!current?.transport) return process.send?.(message);
  const meter = current.transport,
    probe = performance.now();
  const bytes = Buffer.byteLength(JSON.stringify(message));
  const started = performance.now();
  process.send?.(message);
  meter.sendCalls++;
  meter.jsonBytes += bytes;
  meter.sendMs += performance.now() - started;
  meter.sizingMs += started - probe;
};
function progress(barrier: boolean) {
  if (!current) return;
  lastSent = performance.now();
  const timing = current.timing ? { ...current.timing } : undefined;
  if (timing && current.cpuStart) {
    const cpu = process.cpuUsage(current.cpuStart);
    timing.processCpuMs = (cpu.user + cpu.system) / 1000;
    timing.transport = { ...current.transport! };
  }
  if (timing && activeSlice?.ownerId === current.id) {
    const cpu = process.cpuUsage(activeSlice.cpu);
    timing.activeMs += performance.now() - activeSlice.started;
    timing.cpuMs += (cpu.user + cpu.system) / 1000;
  }
  send({
    type: "progress",
    id: current.id,
    snapshot: current.search.snapshot(),
    memoryBytes: process.memoryUsage.rss(),
    barrier,
    ...(current.reply ? { reply: current.reply } : {}),
    ...(current.taskId === undefined ? {} : { taskId: current.taskId }),
    ...(timing ? { timing } : {}),
  });
}
function schedule() {
  if (scheduled || !current || current.paused || current.barrier) return;
  scheduled = true;
  setTimeout(() => {
    scheduled = false;
    if (!current || current.paused || current.barrier) return;
    const started = performance.now();
    const owner = current;
    const cpu = current.timing ? process.cpuUsage() : null;
    if (cpu) activeSlice = { ownerId: owner.id, started, cpu };
    try {
      do {
        const done = current.search.step();
        const plan = current.partition ? current.search.takeSplitPlan() : null;
        if (plan) current.reply = { kind: "split", plan };
        else if (done) {
          const result = current.search.subtreeResult();
          if (result) current.reply = { kind: "subtree", result };
        }
        if (plan || done || current.search.depth !== current.depth) {
          current.depth = current.search.depth;
          current.barrier = true;
          progress(true);
          return;
        }
      } while (performance.now() - started < 8);
      if (performance.now() - lastSent >= 100) progress(false);
      schedule();
    } catch (error) {
      const id = current.id;
      current.search.dispose();
      current = null;
      send({ type: "error", id, error: String(error) });
    } finally {
      if (owner?.timing && cpu) {
        const used = process.cpuUsage(cpu);
        owner.timing.activeMs += performance.now() - started;
        owner.timing.cpuMs += (used.user + used.system) / 1000;
      }
      activeSlice = null;
    }
  }, 0);
}
process.on("message", async (raw: unknown) => {
  const message = raw as SearchCommand;
  if (message.type === "close") {
    current?.search.dispose();
    process.exit(0);
  }
  if (message.type === "start") {
    const token = ++generation;
    requestedId = message.id;
    requestedPaused = false;
    current?.search.dispose();
    current = null;
    try {
      const restored = performance.now();
      const cpuStart = message.measureTransport ? process.cpuUsage() : undefined;
      const position = await restoreStudyPosition(message.input);
      const created = performance.now();
      const restoreCpu = cpuStart ? process.cpuUsage(cpuStart) : undefined;
      if (token !== generation) return;
      const search = createStudyRootSearch(position, message.options);
      const createCpu = cpuStart ? process.cpuUsage(cpuStart) : undefined;
      current = {
        id: message.id,
        search,
        paused: requestedPaused,
        barrier: false,
        depth: 0,
        partition: false,
        ...(cpuStart
          ? { cpuStart, transport: { sendCalls: 0, jsonBytes: 0, sendMs: 0, sizingMs: 0 } }
          : {}),
        ...(message.options.measureDetails || message.measureTransport
          ? {
              timing: {
                restoreMs: created - restored,
                createMs: performance.now() - created,
                activeMs: 0,
                cpuMs: 0,
                ...(restoreCpu && createCpu
                  ? {
                      restoreCpuMs: (restoreCpu.user + restoreCpu.system) / 1000,
                      createCpuMs:
                        (createCpu.user + createCpu.system - restoreCpu.user - restoreCpu.system) /
                        1000,
                    }
                  : {}),
              },
            }
          : {}),
      };
      progress(false);
      schedule();
    } catch (error) {
      send({ type: "error", id: message.id, error: String(error) });
    }
    return;
  }
  if (message.id !== requestedId) return;
  if (message.type === "cancel") {
    generation++;
    requestedId = null;
    current?.search.dispose();
    current = null;
    return;
  }
  if (message.type === "pause") requestedPaused = true;
  if (message.type === "resume") requestedPaused = false;
  if (!current || current.id !== message.id) return;
  if (message.type === "task" || message.type === "subtree" || message.type === "finish") {
    try {
      if (!current.barrier) throw new Error("実行中の探索へタスクを重ねられません");
      const initialized = current.timing ? performance.now() : 0;
      const initCpu = current.timing ? process.cpuUsage() : undefined;
      if (message.type === "task")
        current.search.startTask(
          message.index,
          message.depth,
          message.material,
          message.policy,
          message.partition,
        );
      else if (message.type === "subtree") current.search.startSubtree(message.task);
      else current.search.finishSplitPlan(message.planId, message.results);
      current.reply = undefined;
      if (current.timing && initCpu) {
        const cpu = process.cpuUsage(initCpu);
        current.timing.taskInitMs =
          (current.timing.taskInitMs ?? 0) + performance.now() - initialized;
        current.timing.taskInitCpuMs =
          (current.timing.taskInitCpuMs ?? 0) + (cpu.user + cpu.system) / 1000;
      }
      current.partition =
        message.type === "task" && message.partition === true && message.depth >= 4;
      current.taskId = message.taskId;
      current.depth = current.search.depth;
      current.barrier = false;
      schedule();
    } catch (error) {
      send({ type: "error", id: message.id, error: String(error) });
    }
    return;
  }
  if (message.type === "pause") {
    current.paused = true;
    progress(false);
    return;
  }
  if (message.type === "resume") {
    current.paused = false;
    progress(current.barrier);
    schedule();
    return;
  }
  if (message.type === "continue") {
    if (!current.barrier || current.depth !== message.depth) return;
    if (message.indices) current.search.setRootIndices(message.indices);
    current.barrier = false;
    schedule();
  }
});
process.on("disconnect", () => {
  current?.search.dispose();
  process.exit(0);
});
send({ type: "ready" });
