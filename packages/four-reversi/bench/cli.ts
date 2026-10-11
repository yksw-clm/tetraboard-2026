import { mkdtempSync, rmSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { applyAction, colors, getLegalMoves, type GameMode } from "../src/index";
import { chooseCpuMoveWithDiagnostics } from "../src/cpu";
import { defaultEvaluationWeights, resolveWeights } from "../src/cpuEvaluation";
import { defaultSearchOptions, type SearchOptions, type SearchStats } from "../src/cpuSearch";
import {
  openingPosition,
  playMatch,
  summarizeMatches,
  summarizeTimes,
  type MatchSample,
  type Selector,
} from "./measurement";
import { endgameCases, performancePositions, tacticalCases } from "./positions";
import { solveEndgame } from "./oracle";

const baselineCommit = "23548378d5755cf13c3850857aea06da49293f93";
const args = new Map(
  Bun.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, "").split("=");
    return [key, rest.length ? rest.join("=") : "true"];
  }),
);
const repoRoot = join(import.meta.dir, "../../..");
const directory = mkdtempSync(join(tmpdir(), "tetraboard-reversi-baseline-"));
const git = (...options: string[]) => {
  const result = Bun.spawnSync(["git", ...options], { cwd: repoRoot });
  if (result.exitCode !== 0) throw new Error(`git ${options[0]}に失敗しました`);
  return result.stdout.toString().trim();
};
function integer(name: string, fallback: number) {
  const value = Number(args.get(name) ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name}は正の整数で指定してください`);
  return value;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

try {
  const archive = Bun.spawnSync(["git", "archive", baselineCommit, "packages/four-reversi/src"], {
    cwd: repoRoot,
  });
  if (archive.exitCode !== 0) throw new Error("比較対象コミットを取得できません");
  const extracted = Bun.spawnSync(["tar", "-xf", "-", "-C", directory], { stdin: archive.stdout });
  if (extracted.exitCode !== 0) throw new Error("比較対象ソースを展開できません");
  const old = await import(
    pathToFileURL(join(directory, "packages/four-reversi/src/index.ts")).href
  );
  const baseline: Selector = (state) => old.chooseCpuMove(state, 2);
  if (
    args.has("candidate") &&
    args.get("candidate") !== "baseline" &&
    args.get("candidate") !== "current"
  )
    throw new Error("candidateはcurrentまたはbaselineで指定してください");
  const searchOptions: SearchOptions = {
    maxWork: integer("max-work", defaultSearchOptions.maxWork),
    maxDepth: integer("max-depth", defaultSearchOptions.maxDepth),
    width: integer("width", defaultSearchOptions.width),
    endgameEmpties: integer("endgame-empties", defaultSearchOptions.endgameEmpties),
    cacheLimit: defaultSearchOptions.cacheLimit,
    policyForecast: args.get("policy-forecast") !== "false",
    evaluationWeights: args.has("weights")
      ? resolveWeights(JSON.parse(args.get("weights")!))
      : defaultEvaluationWeights,
  };
  let lastStats: SearchStats | undefined;
  const candidate: Selector =
    args.get("candidate") === "baseline"
      ? baseline
      : (state) => {
          const selected = chooseCpuMoveWithDiagnostics(state, searchOptions);
          lastStats = selected.stats;
          return selected.move;
        };
  const metadata = {
    commit: git("rev-parse", "HEAD"),
    dirty: git("status", "--porcelain").length > 0,
    baselineCommit,
    bun: Bun.version,
    os: process.platform,
    arch: process.arch,
    cpu: cpus()[0]?.model,
    args: Object.fromEntries(args),
    searchOptions,
    sourceHash: hash(
      await Promise.all(
        [
          "src/index.ts",
          "src/engine.ts",
          "src/moves.ts",
          "src/cpu.ts",
          "src/cpuSearch.ts",
          "src/cpuForecast.ts",
          "src/cpuEvaluation.ts",
          "bench/cli.ts",
          "bench/measurement.ts",
          "bench/positions.ts",
          "bench/oracle.ts",
        ].map(async (path) => [path, await Bun.file(join(import.meta.dir, "..", path)).text()]),
      ),
    ),
  };
  const kind = args.get("kind") ?? "performance";
  let report: unknown;
  if (kind === "compatibility") {
    const corpus = [...performancePositions(), ...endgameCases(500, 40)];
    let transitions = 0;
    for (const { state } of corpus) {
      if (JSON.stringify(getLegalMoves(state)) !== JSON.stringify(old.getLegalMoves(state)))
        throw new Error("旧エンジンの合法手と一致しません");
      for (const position of getLegalMoves(state)) {
        const action = { type: "placeStone" as const, position };
        if (
          JSON.stringify(applyAction(state, action)) !==
          JSON.stringify(old.applyAction(state, action))
        )
          throw new Error("旧エンジンの遷移と一致しません");
        transitions++;
      }
    }
    report = {
      metadata,
      corpusHash: hash(corpus),
      positions: corpus.length,
      transitions,
      passed: true,
    };
  } else if (kind === "matches") {
    const mode = args.get("mode") ?? "singles";
    if (mode !== "singles" && mode !== "doubles") throw new Error("modeが不正です");
    const games = integer("games", 4);
    const seats = mode === "singles" ? colors : (["black", "white"] as const);
    if (games % seats.length) throw new Error("gamesは担当色・チーム数の倍数で指定してください");
    const firstSeed = integer("seed", mode === "singles" ? 1000 : 2000);
    const samples: MatchSample[] = [];
    const openings = [];
    for (let game = 0; game < games; game++) {
      const seed = firstSeed + Math.floor(game / seats.length);
      const state = openingPosition(mode as GameMode, seed);
      if (game % seats.length === 0) openings.push({ seed, state });
      samples.push(playMatch(state, candidate, baseline, seats[game % seats.length], seed));
      report = {
        metadata,
        mode,
        complete: game + 1 === games,
        corpusHash: hash(openings),
        samples,
        summary: summarizeMatches(samples),
      };
      if (args.has("output")) await Bun.write(args.get("output")!, JSON.stringify(report, null, 2));
      if ((game + 1) % seats.length === 0) process.stderr.write(`${game + 1}/${games}\n`);
    }
  } else if (kind === "performance") {
    const corpus = performancePositions();
    const times: number[] = [];
    const samples = corpus.flatMap(({ id, state }) => {
      candidate(state);
      return Array.from({ length: integer("repeats", 5) }, () => {
        const before = performance.now();
        const move = candidate(state);
        const ms = performance.now() - before;
        times.push(ms);
        return { id, ms, move, stats: lastStats };
      });
    });
    report = {
      metadata,
      corpusHash: hash(corpus),
      positions: corpus.length,
      samples,
      summary: summarizeTimes(times),
    };
  } else if (kind === "tactics" || kind === "endgame") {
    const split = args.get("split") ?? "validation";
    if (split !== "training" && split !== "validation") throw new Error("splitが不正です");
    const corpus =
      kind === "tactics"
        ? tacticalCases(split)
        : endgameCases(split === "training" ? 10000 : 30000, integer("cases", 200));
    const samples = corpus.map((entry) => {
      const { id, state, labels } = entry;
      const expected = solveEndgame(state);
      const move = candidate(state);
      return {
        id,
        labels,
        important: "important" in entry && entry.important,
        move,
        expected: expected.moves,
        passed: expected.moves.some((p) => p.x === move?.x && p.y === move?.y),
        oracleNodes: expected.nodes,
        stats: lastStats,
      };
    });
    report = {
      metadata,
      split,
      corpusHash: hash(corpus),
      cases: samples.length,
      correct: samples.filter((sample) => sample.passed).length,
      samples,
    };
  } else throw new Error("kindはmatches、performance、tactics、endgameで指定してください");
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (args.has("output")) await Bun.write(args.get("output")!, json);
  else process.stdout.write(json);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
