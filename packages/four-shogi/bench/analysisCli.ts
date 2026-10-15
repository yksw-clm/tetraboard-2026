import { cpus, release, totalmem } from "node:os";
import { git, repoRoot, sourceIdentity } from "./baseline";
import { measureAnalysisPerformance } from "./singlesPerformance";
import type { AiOptions } from "../src/ai";

const args = new Map<string, string>();
const allowed = new Set([
  "restricted",
  "max-work",
  "max-depth",
  "width",
  "root-width",
  "extensions",
  "candidate-count",
  "time-ms",
  "repeats",
  "output",
]);
for (const arg of Bun.argv.slice(2)) {
  const match = /^--([^=]+)=(.+)$/.exec(arg);
  if (!match || !allowed.has(match[1]) || args.has(match[1]))
    throw new Error(`不正・重複した引数: ${arg}`);
  args.set(match[1], match[2]);
}
function integer(name: string, fallback: number, minimum = 1) {
  const value = Number(args.get(name) ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new Error(`${name}は${minimum}以上の整数です`);
  return value;
}
const rule = args.get("restricted") ?? "both";
if (!["true", "false", "both"].includes(rule)) throw new Error("restrictedはtrue/false/bothです");
const options: AiOptions = {
  codeVersion: git("rev-parse", "HEAD"),
  modelId: null,
  maxWork: integer("max-work", 2048),
  maxDepth: integer("max-depth", 64),
  width: integer("width", 6),
  rootWidth: integer("root-width", 24),
  extensions: integer("extensions", 2, 0),
  candidateCount: integer("candidate-count", 3),
  timeBudgetMs: args.has("time-ms") ? integer("time-ms", 0, 0) : null,
};
const report = {
  metadata: {
    schemaVersion: 1,
    measurementKind: "common-analysis-performance-smoke; not-strength-certification",
    runnerCommit: options.codeVersion,
    runnerDirty: git("status", "--porcelain").length > 0,
    runnerSource: sourceIdentity(`${repoRoot}/packages/four-shogi/bench`),
    ruleEngineSource: sourceIdentity(`${repoRoot}/packages/four-shogi/src`),
    args: Object.fromEntries(args),
    environment: {
      bun: Bun.version,
      platform: process.platform,
      osRelease: release(),
      arch: process.arch,
      cpu: cpus()[0]?.model ?? null,
      logicalCpus: cpus().length,
      memoryBytes: totalmem(),
      rssUnit: "bytes",
      timeUnit: "milliseconds",
    },
  },
  complete: true,
  ...(await measureAnalysisPerformance(
    options,
    integer("repeats", 3),
    rule === "both" ? [false, true] : [rule === "true"],
  )),
};
const json = `${JSON.stringify(report, null, 2)}\n`;
if (args.has("output")) await Bun.write(args.get("output")!, json);
else process.stdout.write(json);
