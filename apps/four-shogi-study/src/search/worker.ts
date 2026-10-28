import { createStudyRootSearch } from "@tetraboard/four-shogi/study-search";
import { restoreStudyPosition } from "../domain/study";
import type { SearchCommand, SearchMessage } from "./messages";
let current: {
  id: string;
  search: ReturnType<typeof createStudyRootSearch>;
  paused: boolean;
  barrier: boolean;
  depth: number;
  taskId?: number;
} | null = null;
let generation = 0;
let requestedId: string | null = null;
let requestedPaused = false;
let scheduled = false;
let lastSent = 0;
const send = (message: SearchMessage) => process.send?.(message);
function progress(barrier: boolean) {
  if (!current) return;
  lastSent = performance.now();
  send({
    type: "progress",
    id: current.id,
    snapshot: current.search.snapshot(),
    memoryBytes: process.memoryUsage.rss(),
    barrier,
    ...(current.taskId === undefined ? {} : { taskId: current.taskId }),
  });
}
function schedule() {
  if (scheduled || !current || current.paused || current.barrier) return;
  scheduled = true;
  setTimeout(() => {
    scheduled = false;
    if (!current || current.paused || current.barrier) return;
    const started = performance.now();
    try {
      do {
        const done = current.search.step();
        if (done || current.search.depth !== current.depth) {
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
      const position = await restoreStudyPosition(message.input);
      if (token !== generation) return;
      current = {
        id: message.id,
        search: createStudyRootSearch(position, message.options),
        paused: requestedPaused,
        barrier: false,
        depth: 0,
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
  if (message.type === "task") {
    try {
      if (!current.barrier) throw new Error("実行中の探索へタスクを重ねられません");
      current.search.startTask(message.index, message.depth, message.material);
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
