import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreAnalysisPosition, advanceAnalysisPosition } from "../src/analysis";
import { encodeModelFeatures, currentFeatureSize, historyFeatureSize } from "../src/modelFeatures";
import {
  createDataManifest,
  defaultSelfPlayConfig,
  gamePlans,
  type DataCode,
} from "../bench/selfPlayData";
import { generateSelfPlayGame } from "../bench/selfPlayGame";
import { SelfPlayStore } from "../bench/selfPlayStore";
import { exportTrainingData } from "../bench/trainingExport";
import archive from "../../../test-fixtures/matches/shogi-singles.json";
import { createStateFeatureEncoder, encodeStateFeatures } from "../src/modelFeatureEncoding";

const initial = {
  mode: "singles" as const,
  players: { south: "s", west: "w", north: "n", east: "e" },
  threePlayerAttackProhibited: true,
};
const replay = (events: unknown[] = [], restricted = true) => ({
  schemaVersion: 1,
  ruleProfileId: "tetraboard-four-shogi-singles-v1",
  rulesVersion: 1,
  initial: { ...initial, threePlayerAttackProhibited: restricted },
  events,
});

test("完全履歴特徴のキャッシュは反復回数を区別し、現在情報・保持済み値・容量を保つ", async () => {
  const encoder = createStateFeatureEncoder();
  for (const restricted of [false, true])
    for (const offset of [0, 1, 6, 26]) {
      const position = await restoreAnalysisPosition({
        ...replay(archive.events, restricted),
        eventOffset: offset,
      });
      expect(encoder.encode(position.state)).toEqual(encodeStateFeatures(position.state));
      expect(encoder.encode(position.state)).toEqual(encodeStateFeatures(position.state));
      const before = encoder.encode(position.state),
        key = Object.keys(position.state.repetitions).sort()[0],
        count = position.state.repetitions[key],
        changed = {
          ...position.state,
          repetitions: { ...position.state.repetitions, [key]: count + 1 },
          moveNumber: position.state.moveNumber + 1,
          drawProposals: ["south" as const],
        };
      expect(encoder.encode(changed)).toEqual(encodeStateFeatures(changed));
      expect(before.history[0].values.at(-1)).toBe(count / 4);
      expect(Object.isFrozen(before.history[0].indices)).toBe(true);
      expect(() => before.history[0].values.push(1)).toThrow();
      expect(encoder.encode(position.state)).toEqual(encodeStateFeatures(position.state));
      const limited = createStateFeatureEncoder(2);
      expect(limited.encode(position.state)).toEqual(encodeStateFeatures(position.state));
      expect(limited.stats().entries).toBeLessThanOrEqual(2);
    }
  expect(encoder.stats().hits).toBeGreaterThan(0);
  expect(encoder.stats().entries).toBeLessThanOrEqual(4096);
  expect(() => createStateFeatureEncoder(-1)).toThrow("上限");
  expect(() => createStateFeatureEncoder(8193)).toThrow("上限");
  const position = await restoreAnalysisPosition(replay());
  expect(() =>
    encoder.encode({
      ...position.state,
      repetitions: Object.fromEntries(Array.from({ length: 2049 }, (_, i) => [String(i), 1])),
    }),
  ).toThrow("切り捨てず");
});

test("特徴版1は絶対座標の4方向・実手番・ON/OFFを固定位置で区別する", async () => {
  const on = await restoreAnalysisPosition(replay());
  const off = await restoreAnalysisPosition(replay([], false));
  const features = encodeModelFeatures(on);
  expect(currentFeatureSize).toBe(4481);
  expect(historyFeatureSize).toBe(4463);
  for (const king of [2509, 1197, 149, 1477]) expect(features.current.indices).toContain(king);
  expect(features.current.indices).toContain(2693);
  expect(features.current.indices).toContain(4462);
  expect(encodeModelFeatures(off).current.indices).not.toContain(4462);
  expect(() => encodeModelFeatures({ ...on })).toThrow("解析API");
});

test("攻撃/取り返し・反復辞書の全項目を保持し、提案も入力に含める", async () => {
  const position = await restoreAnalysisPosition({ ...replay(archive.events), eventOffset: 6 });
  const features = encodeModelFeatures(position);
  expect(features.history).toHaveLength(Object.keys(position.state.repetitions).length);
  const counts = features.history.map((entry) => entry.values[entry.indices.indexOf(4462)] * 4);
  expect(counts).toEqual(
    Object.keys(position.state.repetitions)
      .sort()
      .map((key) => position.state.repetitions[key]),
  );
  expect(features.current.indices.some((index) => index >= 2698 && index < 4462)).toBe(true);
  const start = await restoreAnalysisPosition(replay());
  const proposed = await advanceAnalysisPosition(start, {
    type: "drawProposal",
    side: "south",
    proposed: true,
  });
  expect(encodeModelFeatures(proposed).current.indices).toContain(4463);
  const setup = [
    ["south", "D8", "D7"],
    ["west", "B4", "C4"],
    ["north", "D2", "D3"],
    ["east", "H4", "G4"],
    ["south", "F8", "F7"],
    ["west", "B6", "C6"],
    ["north", "F2", "F3"],
    ["east", "H6", "G6"],
  ];
  const cycle = [
    ["south", "D9", "D8"],
    ["west", "A4", "B4"],
    ["north", "D1", "D2"],
    ["east", "I4", "H4"],
    ["south", "D8", "D9"],
    ["west", "B4", "A4"],
    ["north", "D2", "D1"],
    ["east", "H4", "I4"],
  ];
  const square = (text: string) => ({ x: text.charCodeAt(0) - 65, y: Number(text[1]) - 1 });
  const events = Array.from({ length: 32 }, (_, index) => {
    const [side, from, to] = index < 8 ? setup[index] : cycle[(index - 8) % 8];
    return {
      index,
      event: {
        type: "action",
        side,
        action: { type: "movePiece", from: square(from), to: square(to), promote: false },
      },
    };
  });
  const repeated = await restoreAnalysisPosition(replay(events));
  expect(Math.max(...Object.values(repeated.state.repetitions))).toBe(4);
  expect(
    encodeModelFeatures(repeated).history.some(
      (entry) => entry.values[entry.indices.indexOf(4462)] === 1,
    ),
  ).toBe(true);
  const captured = await restoreAnalysisPosition({ ...replay(archive.events), eventOffset: 26 });
  expect(encodeModelFeatures(captured).current.indices).toContain(4138 + 5 * 9 + 4);
});

test("TSで再生検査した単一datasetを出力し、打切りをValueへ混ぜず既存出力を上書きしない", async () => {
  const root = mkdtempSync(join(tmpdir(), "four-shogi-learning-test-"));
  const source = join(root, "source"),
    output = join(root, "output");
  const code: DataCode = {
    commit: "0".repeat(40),
    dirty: false,
    sourceHash: "1".repeat(64),
    runnerHash: "2".repeat(64),
    runtime: { bun: Bun.version, platform: process.platform, arch: process.arch },
  };
  const config = {
    ...defaultSelfPlayConfig(),
    origins: [{ seed: 19000 }, { seed: 59000 }],
    agents: [{ id: "a", kind: "analysis", options: { maxWork: 16 } }],
    lineups: [["a", "a", "a", "a"]],
    seatOffsets: ["south"],
    teacher: { maxWork: 128, extensions: 0 },
    sampling: { every: 1, important: false, maxPositions: 1 },
    maxPlies: 2,
  };
  try {
    const manifest = await createDataManifest(config, code);
    const store = new SelfPlayStore(source, 8 * 1024 ** 2);
    try {
      store.writeManifest(manifest);
      for (const plan of gamePlans(manifest))
        store.writeGame(
          await generateSelfPlayGame(manifest, plan, null, async () => {}, {
            now: () => 0,
            yieldToHost: async () => {},
          }),
        );
    } finally {
      store.close();
    }
    const result = await exportTrainingData(source, output);
    expect(result.samples.splits).toEqual({ train: 2, validation: 2, calibration: 0, test: 0 });
    const text = readFileSync(join(output, "samples.jsonl"), "utf8");
    const samples = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      samples.every((sample) => sample.valueTarget === null && sample.status === "truncated"),
    ).toBe(true);
    expect(samples.every((sample) => sample.legalActionIds.includes(sample.policyTarget))).toBe(
      true,
    );
    expect(new Set(samples.map((sample) => sample.restricted))).toEqual(new Set([false, true]));
    expect(new Bun.CryptoHasher("sha256").update(text).digest("hex")).toBe(result.samples.sha256);
    await expect(exportTrainingData(source, output)).rejects.toThrow();
    await expect(exportTrainingData(source, join(root, "small"), 32)).rejects.toThrow("容量");
    writeFileSync(join(source, "unrelated.txt"), "preserve");
    await expect(exportTrainingData(source, join(root, "invalid"))).rejects.toThrow("無関係");
    expect(readFileSync(join(source, "unrelated.txt"), "utf8")).toBe("preserve");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);
