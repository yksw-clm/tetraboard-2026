import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chooseCpuAction } from "../src/cpu";
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
  const old = await baseline();
  const candidate: Selector =
    args.get("candidate") === "baseline" ? old : (state) => chooseCpuAction(state, 2);
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
      const times = Array.from({ length: repeats }, () => {
        const start = performance.now();
        candidate(state);
        return performance.now() - start;
      });
      return { name, ...summarizeTimes(times), times };
    });
    report = {
      metadata,
      corpusHash,
      measurements,
      summary: summarizeTimes(measurements.flatMap((entry) => entry.times)),
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
      const seed = 1000 + Math.floor(game / seats.length);
      const seat = seats[game % seats.length];
      samples.push(
        playMatch(openingPosition(mode, restricted, seed), candidate, old, seat, seed, maxPlies),
      );
      process.stderr.write(`${game + 1}/${games} ${JSON.stringify(samples.at(-1))}\n`);
    }
    report = { metadata, mode, restricted, maxPlies, samples, summary: summarizeMatches(samples) };
  } else throw new Error("kindはperformanceまたはmatchesを指定してください");
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (args.has("output")) await Bun.write(args.get("output")!, json);
  else process.stdout.write(json);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
