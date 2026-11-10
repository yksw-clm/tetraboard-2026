import { mkdir, readFile, rename } from "node:fs/promises";
import { arch, cpus, platform, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  applyAction,
  chooseCpuMove,
  createInitialState,
  getLegalMoves,
  type Color,
  type Position,
  type ReversiState,
} from "../../reversi/src/index";
import { sourceIdentity } from "./sourceIdentity";
import {
  pairs,
  profiles,
  random,
  summarize,
  type OpeningScores,
  type Profile,
  type Score,
} from "./reversiCalibrationStatistics";

type Playing = Extract<ReversiState, { status: "playing" }>;
const [output, image, smoke] = process.argv.slice(2);
if (!output || !image || (smoke !== undefined && smoke !== "--smoke") || process.argv.length > 5)
  throw Error(
    "使い方: bun run study:reversi-calibration <結果JSON> <ローカルDockerイメージ> [--smoke]",
  );
const parallelism = Number(process.env.TETRABOARD_REVERSI_CALIBRATION_PROCESSES ?? 4);
if (!Number.isInteger(parallelism) || parallelism < 1 || parallelism > 8)
  throw Error("プロセス数は1〜8の整数にしてください");

const enginePath = "/opt/egaroucid/egaroucid";
const engineDirectory = dirname(enginePath);
const options = ["-quiet", "-nobook", "-thread", "1", "-hashlevel", "18", "-mode", "3"];
const dockerRun = [
  "docker",
  "run",
  "--rm",
  "--pull=never",
  "--platform=linux/amd64",
  "--network=none",
];
const configuration = {
  local2: { level: 2, engineProbability: 0 },
  mix25: { level: 1, engineProbability: 0.25 },
  mix50: { level: 1, engineProbability: 0.5 },
  mix75: { level: 1, engineProbability: 0.75 },
  level1: { level: 1, engineProbability: 1 },
  level2: { level: 2, engineProbability: 1 },
  level4: { level: 4, engineProbability: 1 },
  level8: { level: 8, engineProbability: 1 },
};
function command(args: string[]) {
  const result = Bun.spawnSync(args);
  if (!result.success) throw Error(result.stderr.toString().trim() || `失敗: ${args[0]}`);
  return result.stdout.toString().trim();
}
const imageId = command(["docker", "image", "inspect", "--format", "{{.Id}}", image]);
const engineFiles = command([
  ...dockerRun,
  "--entrypoint",
  "/bin/sh",
  "--workdir",
  engineDirectory,
  imageId,
  "-ec",
  "sha256sum egaroucid resources/eval.egev2 resources/eval_move_ordering_end.egev && ./egaroucid -version",
]);
if (
  !engineFiles.includes("Egaroucid for Console 7.8.2") ||
  !engineFiles.includes(
    "0a8acbcbc23067933627f1bcc83c3f7ae6b7ff3e603d174a3364271fcaeeef2f  resources/eval.egev2",
  ) ||
  !engineFiles.includes(
    "bd908885e8bb85e72a9be2b0399f8ca52ed40a138bcaaecca3d13710945b9a93  resources/eval_move_ordering_end.egev",
  )
)
  throw Error("対象のエンジン版と評価ファイルを確認できません");

const square = ({ x, y }: Position) => String.fromCharCode(97 + x) + String(y + 1);
function play(state: ReversiState, position: Position) {
  const result = applyAction(state, { type: "placeStone", position });
  if (!result.ok) throw Error(`不正着手 ${square(position)}: ${result.reason}`);
  return result.state;
}
function board(state: Playing) {
  return state.board
    .flat()
    .map((cell) => (cell === "black" ? "B" : cell === "white" ? "W" : "-"))
    .join("");
}

function openingIdentity(state: Playing) {
  const cells = state.board
    .flat()
    .map((cell) => (cell === null ? "-" : cell === state.turn ? "P" : "O"));
  const variants: string[] = [];
  for (const swap of [false, true])
    for (const flipX of [false, true])
      for (const flipY of [false, true])
        variants.push(
          cells
            .map((_, i) => {
              const a = i % 8,
                b = Math.floor(i / 8);
              const x = swap ? b : a,
                y = swap ? a : b;
              return cells[(flipY ? 7 - y : y) * 8 + (flipX ? 7 - x : x)];
            })
            .join(""),
        );
  return variants.sort()[0]!;
}

function makeOpening(seed: number) {
  const next = random(seed);
  const depth = 6 + (seed % 4);
  const transcript: string[] = [];
  let state = createInitialState();
  for (let i = 0; i < depth; i++) {
    const moves = getLegalMoves(state);
    const move = moves[Math.floor(next() * moves.length)]!;
    transcript.push(square(move));
    state = play(state, move);
  }
  if (state.status !== "playing") throw Error("序盤で終局しました");
  return { seed, state, transcript: transcript.join("") };
}

const stages = [
  { stage: "calibration", seed: 2_100_000, count: smoke ? 2 : 96 },
  { stage: "evaluation", seed: 3_100_000, count: smoke ? 2 : 64 },
] as const;
const seen = new Set<string>();
const openings = stages.flatMap(({ stage, seed, count }) => {
  const selected = [];
  while (selected.length < count) {
    const opening = makeOpening(seed++);
    const identity = openingIdentity(opening.state);
    if (seen.has(identity)) continue;
    seen.add(identity);
    selected.push({ ...opening, stage });
  }
  return selected;
});

function startEngine() {
  const name = "tetraboard-reversi-calibration-" + crypto.randomUUID();
  const child = Bun.spawn(
    [
      ...dockerRun,
      "-i",
      "--name",
      name,
      "--entrypoint",
      enginePath,
      "--workdir",
      engineDirectory,
      imageId,
      ...options,
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "ignore" },
  );
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let closing: Promise<void> | undefined;
  function close() {
    return (closing ??= (async () => {
      const cleanup = Bun.spawn(["docker", "rm", "-f", name], {
        stdout: "ignore",
        stderr: "ignore",
      });
      await cleanup.exited;
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await child.exited;
    })());
  }
  return {
    async move(state: Playing, level: number) {
      const timer = setTimeout(() => void close(), 30_000);
      try {
        child.stdin.write(
          `clearcache\nlevel ${level}\nsetboard ${board(state)} ${state.turn === "black" ? "B" : "W"}\ngo\n`,
        );
        await child.stdin.flush();
        while (!pending.includes("\n")) {
          const data = await reader.read();
          if (data.done) throw Error("Egaroucidが着手を返さず終了しました");
          pending += decoder.decode(data.value, { stream: true });
        }
        const end = pending.indexOf("\n");
        const move = pending.slice(0, end).trim();
        pending = pending.slice(end + 1);
        if (!/^[a-h][1-8]$/.test(move)) throw Error(`不正なEgaroucid応答: ${move}`);
        return { x: move.charCodeAt(0) - 97, y: Number(move[1]) - 1 };
      } finally {
        clearTimeout(timer);
      }
    },
    close,
  };
}

async function game(
  engine: ReturnType<typeof startEngine>,
  opening: (typeof openings)[number],
  a: Profile,
  b: Profile,
  aColor: Color,
) {
  let state: ReversiState = opening.state;
  let engineMoves = 0;
  const transcript: string[] = [];
  const randomFor = (profile: Profile) =>
    random(opening.seed ^ Math.imul(profiles.indexOf(profile) + 1, 0x9e3779b9));
  const randomA = randomFor(a);
  const randomB = randomFor(b);
  while (state.status === "playing") {
    const isA = state.turn === aColor;
    const profile = isA ? a : b;
    const next = isA ? randomA : randomB;
    const setting = configuration[profile];
    const external =
      setting.engineProbability === 1 ||
      (setting.engineProbability > 0 && next() < setting.engineProbability);
    const move = external
      ? await engine.move(state, setting.level)
      : chooseCpuMove(state, profile === "local2" ? 2 : 1, next);
    if (!move) throw Error("合法手がありません");
    state = play(state, move);
    if (external) engineMoves++;
    transcript.push(square(move));
  }
  const score: Score = state.result.winner === null ? 0.5 : state.result.winner === aColor ? 1 : 0;
  return { aColor, score, engineMoves, transcript: transcript.join(""), result: state.result };
}

async function runOpening(
  engine: ReturnType<typeof startEngine>,
  opening: (typeof openings)[number],
) {
  const games = [];
  const scores: [Score, Score][] = [];
  for (const { a, b } of pairs) {
    const black = await game(engine, opening, a, b, "black");
    const white = await game(engine, opening, a, b, "white");
    games.push({ a, b, black, white });
    scores.push([black.score, white.score]);
  }
  return { seed: opening.seed, stage: opening.stage, opening: opening.transcript, games, scores };
}

const results: Awaited<ReturnType<typeof runOpening>>[] = [];
let nextOpening = 0;
let stopped = false;
let completed = 0;
const started = performance.now();
const engines = Array.from({ length: Math.min(parallelism, openings.length) }, startEngine);
const stop = () => {
  stopped = true;
  void Promise.all(engines.map((engine) => engine.close()));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
try {
  const runs = await Promise.allSettled(
    engines.map(async (engine) => {
      try {
        while (!stopped && nextOpening < openings.length) {
          const index = nextOpening++;
          results[index] = await runOpening(engine, openings[index]!);
          completed++;
          if (completed % 8 === 0 || completed === openings.length)
            console.log(`序盤 ${completed}/${openings.length} 完了`);
        }
      } catch (error) {
        stopped = true;
        throw error;
      }
    }),
  );
  const failure = runs.find((run) => run.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  if (stopped) throw Error("測定を中断しました");
} finally {
  await Promise.all(engines.map((engine) => engine.close()));
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
}

const scores = (stage: (typeof stages)[number]["stage"]): OpeningScores[] =>
  results.filter((item) => item.stage === stage).map((item) => item.scores);
const samples = smoke ? 20 : 2000;
const root = new URL("..", import.meta.url).pathname;
const identity = await sourceIdentity(root, [
  "scripts/reversiCalibration.ts",
  "scripts/reversiCalibrationStatistics.ts",
  "Dockerfile.reversi",
  "buildEgaroucid.sh",
  "../reversi/src/index.ts",
  "../reversi/src/cpu.ts",
]);
const result = {
  identity,
  imageId,
  engineFiles,
  options,
  configuration,
  stages,
  samples,
  parallelism,
  environment: {
    platform: platform(),
    arch: arch(),
    release: release(),
    cpu: cpus()[0]?.model,
    bun: Bun.version,
  },
  elapsedMs: Math.round(performance.now() - started),
  summary: summarize(scores("calibration"), scores("evaluation"), samples),
  openings: results,
};
const path = resolve(output);
await mkdir(dirname(path), { recursive: true });
await Bun.write(path + ".tmp", JSON.stringify(result, null, 2) + "\n");
await rename(path + ".tmp", path);
console.log(path);
