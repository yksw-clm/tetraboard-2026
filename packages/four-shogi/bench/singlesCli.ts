import { cpus, release, totalmem } from "node:os";
import { sides } from "../src/types";
import type { SearchOptions } from "../src/cpuSearch";
import { defaultEvaluationWeights } from "../src/cpuEvaluation";
import { loadPlayer, git, repoRoot, sourceIdentity, type Player } from "./baseline";
import {
  hashJson,
  matchStarts,
  playSingles,
  seatLineup,
  summarizeSingles,
  type SinglesSample,
} from "./singlesMeasurement";
import { measurePerformance } from "./singlesPerformance";

const args = new Map<string, string>();
const allowed = new Set([
  "kind",
  "candidate",
  "opponents",
  "restricted",
  "start",
  "series",
  "seed",
  "max-plies",
  "max-work",
  "max-depth",
  "width",
  "root-width",
  "extensions",
  "weights",
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
    throw new Error(`${name}は${minimum}以上の整数を指定してください`);
  return value;
}
const options: SearchOptions = {};
for (const [arg, key] of [
  ["max-work", "maxWork"],
  ["max-depth", "maxDepth"],
  ["width", "width"],
  ["root-width", "rootWidth"],
  ["extensions", "extensions"],
] as const) {
  if (args.has(arg)) options[key] = integer(arg, 1, key === "extensions" ? 0 : 1);
}
if (args.has("weights")) {
  const weights: unknown = JSON.parse(args.get("weights")!);
  if (!weights || typeof weights !== "object" || Array.isArray(weights))
    throw new Error("weightsはJSONオブジェクトです");
  for (const [key, value] of Object.entries(weights))
    if (
      !Object.hasOwn(defaultEvaluationWeights, key) ||
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0
    )
      throw new Error(`不正な重み: ${key}`);
  options.evaluationWeights = weights;
}
const kind = args.get("kind") ?? "matches";
if (!["matches", "performance"].includes(kind)) throw new Error("kindはmatches/performanceです");
const rule = args.get("restricted") ?? "both";
if (!["true", "false", "both"].includes(rule)) throw new Error("restrictedはtrue/false/bothです");
const start = args.get("start") ?? "mixed";
if (start !== "mixed" && start !== "initial" && start !== "opening")
  throw new Error("startはinitial/opening/mixedです");
const seed = integer("seed", 1000, 0);
const series = integer("series", start === "initial" ? 1 : 2);
if (!Number.isSafeInteger(seed + series - 1) || seed + series - 1 > 0xffffffff)
  throw new Error("seedの系列範囲は32bit符号なし整数です");
const players: Player[] = [];
try {
  const candidate = await loadPlayer(args.get("candidate") ?? "current", options);
  players.push(candidate);
  const opponentNames = (args.get("opponents") ?? "frozen,frozen,frozen").split(",");
  if (opponentNames.length !== 3) throw new Error("opponentsは候補席の次から実手番順に3体です");
  for (const name of [...new Set(opponentNames)]) players.push(await loadPlayer(name));
  const opponents = opponentNames.map((name) =>
    players.slice(1).find((player) => player.metadata.selector === name)!,
  );
  const selectors = new Map(players.map((player) => [player.id, player.selector]));
  const metadata = {
    schemaVersion: 1,
    measurementKind: "smoke-or-experiment; not-strength-certification",
    ruleProfileId: "tetraboard-four-shogi-singles-v1",
    rulesVersion: 1,
    runnerCommit: git("rev-parse", "HEAD"),
    runnerDirty: git("status", "--porcelain").length > 0,
    runnerSource: sourceIdentity(`${repoRoot}/packages/four-shogi/bench`),
    ruleEngineSource: sourceIdentity(`${repoRoot}/packages/four-shogi/src`),
    players: players.map((player) => ({ id: player.id, ...player.metadata })),
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
    opponentPlacement:
      "candidate seat then the next three sides in south/west/north/east order; all four candidate seats",
    drawPolicy:
      "action-only harness; agreement proposals, clocks and disconnects are not simulated",
  };
  async function output(report: unknown) {
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (args.has("output")) await Bun.write(args.get("output")!, json);
    else process.stdout.write(json);
  }
  if (kind === "performance") {
    await output({
      metadata,
      complete: true,
      ...measurePerformance(
        candidate.selector,
        integer("repeats", 5),
        rule === "both" ? [false, true] : [rule === "true"],
      ),
    });
  } else {
    const restrictions = rule === "both" ? [false, true] : [rule === "true"];
    const starts = restrictions.map((restricted) => ({
      restricted,
      starts: matchStarts(start, restricted, series, seed),
    }));
    const corpusHash = hashJson(starts);
    const groups: {
      restricted: boolean;
      samples: SinglesSample[];
      summary: ReturnType<typeof summarizeSingles> | null;
    }[] = restrictions.map((restricted) => ({ restricted, samples: [], summary: null }));
    const maxPlies = integer("max-plies", 400);
    const total = restrictions.length * series * 4;
    let completed = 0;
    const report = (complete: boolean) => ({
      metadata,
      corpusHash,
      maxPlies,
      requestedGames: total,
      completedGames: completed,
      complete,
      groups,
    });
    if (args.has("output")) await output(report(false));
    for (const group of groups)
      for (const position of starts.find((entry) => entry.restricted === group.restricted)!.starts)
        for (const seat of sides) {
          const lineup = seatLineup(
            seat,
            candidate.id,
            opponents.map((player) => player.id),
          );
          group.samples.push(playSingles(position, seat, lineup, selectors, maxPlies));
          group.summary = summarizeSingles(group.samples, group.samples.length === series * 4);
          completed++;
          process.stderr.write(
            `${completed}/${total} restricted=${group.restricted} seed=${position.seed} seat=${seat} ${group.samples.at(-1)!.termination}\n`,
          );
          if (args.has("output")) await output(report(completed === total));
        }
    await output(report(true));
  }
} finally {
  for (const player of players) player.dispose();
}
