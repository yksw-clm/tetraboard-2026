import os from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StudyStore } from "../domain/store";
import { LocalStudyApplication } from "./application";
import { createStudyHttpHandler } from "./http";
import { createLiveRoomSession } from "./liveRoom";
import { createStudySearchRuntime } from "../search/runtime";

const logicalCpus = os.availableParallelism();
const totalMemoryMb = Math.floor(os.totalmem() / 1024 ** 2);
const dataDirectory =
  process.env.STUDY_DATA_DIR ??
  resolve(os.homedir(), "Library/Application Support/Tetraboard Study");
const config = {
  logicalCpus,
  totalMemoryMb,
  defaultThreads: Math.min(4, Math.max(1, logicalCpus - 2)),
  defaultMemoryMb: Math.max(256, Math.min(8192, Math.floor(totalMemoryMb / 3))),
  dataDirectory,
};
const port = Number(process.env.STUDY_PORT ?? 5198);
if (!Number.isInteger(port) || port < 0 || port > 65535)
  throw new Error("STUDY_PORTは0〜65535の整数です");
const allowedOrigins = ["https://tetraboard.net", "https://tetraboard-dev.chaossi-lab.workers.dev"];
if (process.env.STUDY_LOCAL_WORKER_ORIGIN) {
  const local = new URL(process.env.STUDY_LOCAL_WORKER_ORIGIN);
  if (
    local.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(local.hostname) ||
    local.origin !== process.env.STUDY_LOCAL_WORKER_ORIGIN
  )
    throw new Error(
      "STUDY_LOCAL_WORKER_ORIGINはlocalhostまたは127.0.0.1のHTTP originを指定してください",
    );
  allowedOrigins.push(local.origin);
}
const taskPartition = process.env.STUDY_TASK_PARTITION ?? "root";
if (taskPartition !== "root" && taskPartition !== "replies")
  throw new Error("STUDY_TASK_PARTITIONはrootまたはrepliesです");
const replyCacheBudget = process.env.STUDY_REPLY_CACHE_BUDGET ?? "roots";
if (replyCacheBudget !== "roots" && replyCacheBudget !== "workers")
  throw new Error("STUDY_REPLY_CACHE_BUDGETはrootsまたはworkersです");
const app = new LocalStudyApplication(
  new StudyStore(dataDirectory),
  config,
  (options) => createStudySearchRuntime({ ...options, taskPartition, replyCacheBudget }),
  (input, callbacks) => createLiveRoomSession(input, callbacks, { allowedOrigins }),
);
const assetsDirectory = fileURLToPath(new URL("../../dist", import.meta.url));
const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  idleTimeout: 0,
  maxRequestBodySize: 16 * 1024 * 1024,
  fetch: createStudyHttpHandler(app, config, assetsDirectory),
});
console.info(`四人将棋検討アプリ: http://127.0.0.1:${server.port}`);
console.info(`保存先: ${dataDirectory}`);
console.info(`探索タスク分割: ${taskPartition}`);
console.info(`探索の既定: ${config.defaultThreads}プロセス / ${config.defaultMemoryMb}MiB`);
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await server.stop(true);
  await app.close();
  process.exit(0);
};
process.on("SIGINT", close);
process.on("SIGTERM", close);
