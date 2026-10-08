import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chooseCpuActionWithDiagnostics } from "../src/cpu";
import type { SearchOptions, SearchStats } from "../src/cpuSearch";
import { defaultEvaluationWeights } from "../src/cpuEvaluation";
import { tacticalCases, acceptsTactic } from "./tactics";
import { sides, type GameMode, type FourShogiState } from "../src/types";
import {
  initialPosition,
  openingPosition,
  playMatch,
  summarizeMatches,
  summarizeTimes,
  type Selector,
  type MatchSample,
} from "./measurement";

const baselineCommit = "3b84f2cdaf9e280b6f84ee34eaa95de8a1441d03";
const args = new Map(
  Bun.argv.slice(2).map((arg) => {
    const split = arg.indexOf("=");
    return split < 0
      ? [arg.replace(/^--/, ""), "true"]
      : [arg.slice(0, split).replace(/^--/, ""), arg.slice(split + 1)];
  }),
);
const directory = mkdtempSync(join(tmpdir(), "tetraboard-shogi-baseline-"));
const repoRoot = join(import.meta.dir, "../../..");

function integer(name: string, fallback: number): number {
  const value = Number(args.get(name) ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name}は正の整数を指定してください`);
  return value;
}

async function baseline(): Promise<Selector> {
  const archive = Bun.spawnSync(["git", "archive", baselineCommit, "packages/four-shogi/src"], {
    cwd: repoRoot,
  });
  if (archive.exitCode !== 0) throw new Error("比較対象コミットを取得できません");
  const extracted = Bun.spawnSync(["tar", "-xf", "-", "-C", directory], { stdin: archive.stdout });
  if (extracted.exitCode !== 0) throw new Error("比較対象ソースを展開できません");
  const module = await import(
    pathToFileURL(join(directory, "packages/four-shogi/src/cpu.ts")).href
  );
  return (state) => module.chooseCpuAction(state, 2);
}

function performancePositions(): { name: string; state: FourShogiState }[] {
  return (["singles", "doubles"] as const).flatMap((mode) =>
    [false, true].flatMap((restricted) => {
      const initial = initialPosition(mode, restricted);
      const board = initial.board.map((row) =>
        row.map((piece) => (piece?.kind === "king" ? piece : null)),
      );
      const hands = Object.fromEntries(
        sides.map((side) => [side, { rook: 2, gold: 2, silver: 2, pawn: 2 }]),
      ) as FourShogiState["hands"];
      const crowded: FourShogiState = { ...initial, board, hands, repetitions: {} };
      return [
        { name: `${mode}-${restricted}-initial`, state: initial },
        { name: `${mode}-${restricted}-hands`, state: crowded },
        { name: `${mode}-${restricted}-opening`, state: openingPosition(mode, restricted, 301) },
      ];
    }),
  );
}

try {
  const searchOptions: SearchOptions = {};
  if (args.has("max-work")) searchOptions.maxWork = integer("max-work", 2048);
  if (args.has("weights")) {
    const weights: unknown = JSON.parse(args.get("weights")!);
    if (weights === null || typeof weights !== "object" || Array.isArray(weights))
      throw new Error("weightsは評価名と非負の有限数のJSONオブジェクトを指定してください");
    for (const [key, value] of Object.entries(weights))
      if (
        !(key in defaultEvaluationWeights) ||
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < 0
      )
        throw new Error(`不正な評価の重み: ${key}`);
    searchOptions.evaluationWeights = weights;
  }
  const old = await baseline();
  const traces: SearchStats[] = [];
  const candidate: Selector =
    args.get("candidate") === "baseline"
      ? old
      : (state) => {
          const result = chooseCpuActionWithDiagnostics(state, searchOptions);
          traces.push(result.stats);
          return result.action;
        };
  const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repoRoot })
    .stdout.toString()
    .trim();
  const dirty = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: repoRoot })
    .stdout.toString()
    .trim();
  const metadata = {
    baselineCommit,
    candidateCommit: head,
    dirty: dirty.length > 0,
    candidate: args.get("candidate") ?? "current",
    bun: Bun.version,
    platform: process.platform,
    arch: process.arch,
    args: Object.fromEntries(args),
    searchOptions,
  };
  const kind = args.get("kind") ?? "performance";
  let report: unknown;
  if (kind === "performance") {
    const repeats = integer("repeats", 5);
    const positions = performancePositions();
    const corpusHash = new Bun.CryptoHasher("sha256")
      .update(JSON.stringify(positions))
      .digest("hex");
    const measurements = positions.map(({ name, state }) => {
      candidate(state);
      const traceStart = traces.length;
      const times = Array.from({ length: repeats }, () => {
        const start = performance.now();
        candidate(state);
        return performance.now() - start;
      });
      return { name, ...summarizeTimes(times), times, search: traces.slice(traceStart) };
    });
    report = {
      metadata,
      corpusHash,
      measurements,
      summary: summarizeTimes(measurements.flatMap((entry) => entry.times)),
    };
  } else if (kind === "tactics") {
    const split = args.get("split") ?? "all";
    if (!["all", "regression", "validation"].includes(split)) throw new Error("splitが不正です");
    const corpus = tacticalCases().filter((tactic) => split === "all" || tactic.split === split);
    const corpusHash = new Bun.CryptoHasher("sha256").update(JSON.stringify(corpus)).digest("hex");
    const samples = corpus.map((tactic) => {
      const action = candidate(tactic.state);
      return {
        id: tactic.id,
        family: tactic.family,
        split: tactic.split,
        critical: tactic.critical,
        proof: tactic.proof,
        action,
        passed: acceptsTactic(tactic, action),
      };
    });
    report = {
      metadata,
      corpusHash,
      samples,
      cases: samples.length,
      families: new Set(samples.map((sample) => sample.family)).size,
      correct: samples.filter((sample) => sample.passed).length,
      criticalFailures: samples
        .filter((sample) => sample.critical && !sample.passed)
        .map((sample) => sample.id),
      bySplit: Object.fromEntries(
        ["regression", "validation"].map((split) => {
          const group = samples.filter((sample) => sample.split === split);
          return [
            split,
            { cases: group.length, correct: group.filter((sample) => sample.passed).length },
          ];
        }),
      ),
    };
  } else if (kind === "matches") {
    const mode = (args.get("mode") ?? "singles") as GameMode;
    if (mode !== "singles" && mode !== "doubles") throw new Error("modeが不正です");
    const games = integer("games", 4);
    const seats = mode === "singles" ? sides : (["south", "west"] as const);
    if (games % seats.length !== 0) throw new Error("gamesは席数の倍数を指定してください");
    const restricted = args.get("restricted") !== "false";
    const maxPlies = integer("max-plies", 400);
    const samples: MatchSample[] = [];
    for (let game = 0; game < games; game++) {
      const seed = integer("seed", 1000) + Math.floor(game / seats.length);
      const seat = seats[game % seats.length];
      samples.push(
        playMatch(openingPosition(mode, restricted, seed), candidate, old, seat, seed, maxPlies),
      );
      process.stderr.write(`${game + 1}/${games} ${JSON.stringify(samples.at(-1))}\n`);
      if (args.has("output"))
        await Bun.write(
          args.get("output")!,
          JSON.stringify(
            {
              metadata,
              mode,
              restricted,
              maxPlies,
              complete: game + 1 === games,
              samples,
              summary: summarizeMatches(samples),
            },
            null,
            2,
          ),
        );
    }
    report = {
      metadata,
      mode,
      restricted,
      maxPlies,
      complete: true,
      samples,
      summary: summarizeMatches(samples),
    };
  } else throw new Error("kindはperformance、tactics、matchesを指定してください");
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (args.has("output")) await Bun.write(args.get("output")!, json);
  else process.stdout.write(json);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
