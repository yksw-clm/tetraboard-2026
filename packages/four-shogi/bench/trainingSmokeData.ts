import { runSelfPlayDataset } from "./selfPlayRun";
import { exportTrainingData } from "./trainingExport";

// 自然終局のラベルも検証する極小データです。棋力測定や十分な学習集合には使いません。
const args = Bun.argv.slice(2);
if (args.length < 2 || args.length > 3 || (args[2] !== undefined && args[2] !== "--allow-dirty"))
  throw new Error("training:smoke-data <生成先> <新規学習入力先> [--allow-dirty]");
const config = {
  origins: [{ seed: 19000 }, { seed: 59000 }],
  restrictions: [false, true],
  seatOffsets: ["south"],
  agents: [{ id: "small", kind: "analysis", options: { maxWork: 1 } }],
  lineups: [["small", "small", "small", "small"]],
  teacher: { maxWork: 128, extensions: 0 },
  sampling: { every: 16, important: true, maxPositions: 8 },
  maxPlies: 512,
};
const generation = await runSelfPlayDataset(args[0], config, {
  maxGames: 4,
  maxBytes: 128 * 1024 ** 2,
  maxRssBytes: 1024 ** 3,
  maxRunMs: 120000,
  allowDirty: args[2] === "--allow-dirty",
});
if (!generation.complete) throw new Error("生成が中断しました。同じ引数で再開してください");
const exported = await exportTrainingData(args[0], args[1]);
process.stdout.write(JSON.stringify({ generation, samples: exported.samples }, null, 2) + "\n");
