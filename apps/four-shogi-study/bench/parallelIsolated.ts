import { join, resolve } from "node:path";
import { writeFile, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { cpus, release, freemem, loadavg } from "node:os";
import { parallelTrial } from "./parallelSearch";
import { createParallelRecorder } from "./parallelTelemetry";
import { efficiencySource } from "./searchEfficiency";
import { sourceIdentity, repoRoot } from "../../../packages/four-shogi/bench/baseline";
const request = await Bun.file(Bun.argv[2]).json();
const directory = resolve(request.directory);
const source = efficiencySource(),
  fingerprint = JSON.stringify(source);
if (source.dirty) throw Error("測定ソースが未コミットです");
const implementationRoot = resolve(request.implementationRoot ?? repoRoot);
const measuredSource = request.implementationSource ?? source;
const identity = () => ({
  engine: sourceIdentity(join(implementationRoot, "packages/four-shogi/src")),
  runtime: sourceIdentity(join(implementationRoot, "apps/four-shogi-study/src/search")),
});
const expectedIdentity = JSON.stringify({
  engine: measuredSource.engine,
  runtime: measuredSource.runtime,
});
if (JSON.stringify(identity()) !== expectedIdentity) throw Error("比較コードの照合に失敗しました");
for (const peerRoot of request.preloadRoots ?? [])
  await import(join(resolve(peerRoot), "apps/four-shogi-study/src/search/runtime.ts"));
const { createStudySearchRuntime } = await import(
  join(implementationRoot, "apps/four-shogi-study/src/search/runtime.ts")
);
const inputs = await Bun.file(join(directory, "private-inputs/inputs.json")).json();
if (!Number.isSafeInteger(request.inputIndex) || !inputs[request.inputIndex])
  throw Error("入力番号が不正です");
const file = resolve(request.output);
if (await Bun.file(file).exists()) throw Error("既存結果を上書きしません");
if (![1, 2, 4, 8].includes(request.threads)) throw Error("測定workerは1/2/4/8です");
if (
  request.options.timeBudgetMs === null ||
  !Number.isFinite(request.options.timeBudgetMs) ||
  request.options.timeBudgetMs < 1 ||
  request.options.timeBudgetMs > 30000
)
  throw Error("測定期限は1〜30000msです");
if (
  request.maxWork !== undefined &&
  (!Number.isSafeInteger(request.maxWork) || request.maxWork < 1 || request.maxWork > 20000000)
)
  throw Error("測定work上限は1〜20000000です");
const recorder = createParallelRecorder(request.threads);
const runtime = createStudySearchRuntime({
  ...request.config,
  threads: request.threads,
  memoryMb: 8192,
  taskPartition: request.partition ?? "replies",
  measureStages: true,
  observeParallel: recorder.observe,
  ...(request.profileDirectory ? { cpuProfileDirectory: request.profileDirectory } : {}),
});
let id: string | null = null,
  rssStopped = false,
  lastSnapshot: any = null,
  parentRss = 0,
  callbacks = 0,
  result: any = null,
  error: string | null = null,
  phase: "warm" | "main" = "warm",
  mainStarted = false;
const controlled = {
  ...runtime,
  start: (input: any, options: any, callback?: any) =>
    runtime.start(input, options, (s: any) => {
      id = s.id;
      lastSnapshot = s;
      if (phase === "main") mainStarted = true;
      callbacks++;
      callback?.(s);
    }),
};
const control = join(directory, "diagnostics/rss-control.json");
const stopForRss = () => {
  if (rssStopped) return;
  rssStopped = true;
  if (id) void runtime.cancel(id);
};
process.on("SIGUSR2", stopForRss);
try {
  await writeFile(
    control,
    JSON.stringify({ pid: process.pid, signal: "SIGUSR2", output: file }) + "\n",
  );
  if (request.thermal === "warm") {
    await parallelTrial(controlled, inputs[request.inputIndex].input, {
      strategy: "dual-continuations",
      ...request.options,
      timeBudgetMs: 100,
    });
    if (rssStopped) throw Error("warm準備中にRSS上限です");
    callbacks = 0;
  }
  phase = "main";
  result = await parallelTrial(
    controlled,
    inputs[request.inputIndex].input,
    { strategy: "dual-continuations", ...request.options },
    request.maxWork ?? 20000000,
  );
} catch (e) {
  error = String(e);
  result = { snapshot: lastSnapshot, limitReason: rssStopped ? "rss_limit" : "error" };
} finally {
  parentRss = process.memoryUsage.rss();
  await runtime.close();
  const marker = await Bun.file(control)
    .json()
    .catch(() => null);
  if (marker?.pid === process.pid) await unlink(control);
}
if (rssStopped) {
  result.limitReason = "rss_limit";
  result.snapshot = mainStarted ? (lastSnapshot ?? result.snapshot) : null;
}
const row = {
  kind: "search",
  source,
  measuredSource,
  sourceUnchanged:
    JSON.stringify(efficiencySource()) === fingerprint &&
    JSON.stringify(identity()) === expectedIdentity,
  id: inputs[request.inputIndex].id,
  inputSha256: createHash("sha256")
    .update(JSON.stringify(inputs[request.inputIndex].input))
    .digest("hex"),
  strategy: request.options.strategy ?? "dual-continuations",
  variant: request.variant,
  threads: request.threads,
  budget: request.options.timeBudgetMs,
  thermal: request.thermal ?? "cold",
  request,
  result,
  error,
  rssStopped,
  callbacks,
  parallel: id ? recorder.summarize(id) : null,
  system: {
    parentRss,
    loadAverage: loadavg(),
    freeMemoryBytes: freemem(),
    os: release(),
    cpu: cpus()[0]?.model,
    bun: Bun.version,
  },
};
await Bun.write(file, JSON.stringify(row) + "\n");
console.log(
  JSON.stringify({
    id: row.id,
    error,
    rssStopped,
    depth: result.snapshot?.completedDepth,
    reason: result.snapshot?.reason,
    callbacks,
    sourceUnchanged: row.sourceUnchanged,
  }),
);
if (error && !rssStopped) process.exitCode = 1;
