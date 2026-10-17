import { resolve } from "node:path";
import { runSelfPlayDataset, resolveGenerationLimits, type GenerationLimits } from "./selfPlayRun";
import { SelfPlayStore } from "./selfPlayStore";
import { inspectDataStore } from "./selfPlayInspect";

const args = new Map<string, string>();
const known = [
  "kind",
  "output",
  "config",
  "concurrency",
  "max-games",
  "max-bytes",
  "max-rss-mb",
  "max-run-ms",
  "stop-after-moves",
  "allow-dirty",
  "report",
  "python",
  "model-dir",
];
for (const arg of Bun.argv.slice(2)) {
  const match = /^--([^=]+)=(.+)$/.exec(arg);
  if (!match || !known.includes(match[1]) || args.has(match[1]))
    throw new Error(`未知/重複した引数: ${arg}`);
  args.set(match[1], match[2]);
}
const directory = args.get("output");
if (!directory) throw new Error("--outputで専用のdataset保存先を指定してください");
const kind = args.get("kind") ?? "generate";
if (kind !== "generate" && kind !== "inspect") throw new Error("kindはgenerate/inspectです");
if (args.has("python") && !args.has("model-dir"))
  throw new Error("python指定にはmodel-dirが必要です");
if (kind === "inspect" && args.has("model-dir"))
  throw new Error("inspectは保存済み識別とPVを検査し、モデルruntimeを指定しません");
const names = {
  concurrency: "concurrency",
  "max-games": "maxGames",
  "max-bytes": "maxBytes",
  "max-rss-mb": "maxRssBytes",
  "max-run-ms": "maxRunMs",
  "stop-after-moves": "stopAfterMoves",
} as const;
const options: Partial<GenerationLimits> = {};
for (const [arg, key] of Object.entries(names))
  if (args.has(arg)) {
    const value = Number(args.get(arg));
    if (!Number.isSafeInteger(value)) throw new Error(`${arg}は整数です`);
    options[key] = key === "maxRssBytes" ? value * 1024 ** 2 : value;
  }
if (args.has("allow-dirty")) {
  if (!["true", "false"].includes(args.get("allow-dirty")!))
    throw new Error("allow-dirtyはtrue/falseです");
  options.allowDirty = args.get("allow-dirty") === "true";
}
const limits = resolveGenerationLimits(options);
let config: unknown = undefined;
if (args.has("config")) {
  const file = Bun.file(args.get("config")!);
  if (file.size > 4 * 1024 ** 2) throw new Error("設定ファイルは4MiB以下にしてください");
  config = await file.json();
}
const controller = new AbortController();
const stop = () => controller.abort();
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
try {
  let report: unknown;
  if (kind === "generate")
    report = await runSelfPlayDataset(directory, config, limits, {
      signal: controller.signal,
      ...(args.has("model-dir")
        ? {
            modelRuntime: {
              python: args.get("python") ?? "python3",
              directory: resolve(args.get("model-dir")!),
            },
          }
        : {}),
    });
  else {
    if (args.has("config") || args.has("stop-after-moves"))
      throw new Error("inspectではconfig/stop-after-movesを指定しません");
    const store = new SelfPlayStore(directory, limits.maxBytes);
    try {
      report = await inspectDataStore(store);
    } finally {
      store.close();
    }
  }
  const serialized = JSON.stringify(report, null, 2) + "\n";
  const reportPath = args.get("report");
  if (reportPath) {
    if (resolve(reportPath).startsWith(resolve(directory) + "/"))
      throw new Error("reportはdatasetの外へ保存してください");
    await Bun.write(reportPath, serialized);
  }
  process.stdout.write(serialized);
} finally {
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
}
