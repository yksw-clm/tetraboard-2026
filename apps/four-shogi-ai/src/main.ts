import { resolve } from "node:path";
import { aiModelIdSchema } from "@tetraboard/protocol/four-shogi-ai";
import { loadServiceConfig } from "./config";
import { createServiceHandler } from "./http";
import { JobManager } from "./jobs";
import { ProcessPool } from "./processPool";
import { serviceRss } from "./resources";

const config = loadServiceConfig(process.env);
config.modelDirectory = resolve(config.modelDirectory);
const manifestFile = Bun.file(resolve(config.modelDirectory, "manifest.json"));
if (manifestFile.size > 262144) throw new Error("model_manifest_size");
config.modelId = aiModelIdSchema.parse((await manifestFile.json()).modelId);
const pool = new ProcessPool(config);
const log = (entry: object) => process.stdout.write(JSON.stringify(entry) + "\n");
const manager = new JobManager(
  config,
  pool,
  crypto.randomUUID(),
  () => performance.now(),
  () => crypto.randomUUID(),
  log,
);
let closing: Promise<void> | null = null;
function shutdown() {
  if (!closing)
    closing = (async () => {
      clearInterval(timer);
      await manager.shutdown();
      server.stop(true);
      log({ event: "service_stopped" });
    })();
  return closing;
}
const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  maxRequestBodySize: config.maxRequestBytes,
  fetch: createServiceHandler(manager, () => {
    setTimeout(() => void shutdown(), 0);
  }),
});
let resourceBlocked = false,
  maxRssBytes = 0;
const timer = setInterval(() => {
  manager.tick();
  try {
    const rss = serviceRss(pool.pids());
    maxRssBytes = Math.max(maxRssBytes, rss);
    manager.observeMemory(rss);
    if (rss > config.maxRssBytes && !resourceBlocked) {
      resourceBlocked = true;
      manager.resourceLimit();
      log({ event: "memory_limit", rssBytes: rss });
    }
  } catch {
    if (!resourceBlocked) {
      resourceBlocked = true;
      manager.resourceLimit();
      log({ event: "rss_unavailable" });
    }
  }
}, 100);
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
process.on("exit", () => log({ event: "service_resources", maxRssBytes }));
try {
  await pool.start();
  log({
    event: "service_ready",
    serviceInstanceId: manager.instanceId,
    codeVersion: config.codeVersion,
    modelId: config.modelId,
    workers: config.workers,
    workerPids: pool.pids(),
  });
} catch {
  log({ event: "startup_failed" });
  await shutdown();
  process.exitCode = 1;
}
