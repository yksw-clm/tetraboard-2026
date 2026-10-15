import { test, expect } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  symlinkSync,
  readlinkSync,
  watch,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  encodeAction,
  decodeAction,
  rotateAction,
  actionSpaceSize,
  legalActionMask,
} from "../src/actionEncoding";
import {
  analysisRuleProfileId,
  restoreAnalysisPosition,
  getAnalysisLegalActions,
} from "../src/analysis";
import { positionForSide } from "../src/board";
import { sides, type FourShogiState, type Side } from "../src/types";
import {
  createDataManifest,
  defaultSelfPlayConfig,
  gamePlans,
  splitForSeed,
  outcomeFor,
  positionFamilyKey,
  dataHash,
  type DataCode,
  type GameArtifact,
} from "../bench/selfPlayData";
import { generateSelfPlayGame, GenerationPaused } from "../bench/selfPlayGame";
import { validateGameArtifact, inspectDataStore } from "../bench/selfPlayInspect";
import { SelfPlayStore, lockDataset } from "../bench/selfPlayStore";
import { runSelfPlayDataset, resolveGenerationLimits } from "../bench/selfPlayRun";
import archive from "../../../test-fixtures/matches/shogi-singles.json";
import draw from "../../../test-fixtures/matches/shogi-singles-draw.json";

const code: DataCode = {
  commit: "0".repeat(40),
  dirty: false,
  sourceHash: "1".repeat(64),
  runnerHash: "2".repeat(64),
  runtime: { bun: Bun.version, platform: process.platform, arch: process.arch },
};
const initial = {
  mode: "singles" as const,
  players: { south: "s", west: "w", north: "n", east: "e" },
  threePlayerAttackProhibited: true,
};
function replay(events: unknown, eventOffset?: number) {
  return {
    schemaVersion: 1,
    ruleProfileId: analysisRuleProfileId,
    rulesVersion: 1,
    initial,
    events,
    ...(eventOffset === undefined ? {} : { eventOffset }),
  };
}
function config() {
  return {
    ...defaultSelfPlayConfig(),
    agents: [{ id: "a", kind: "analysis", options: { maxWork: 16 } }],
    lineups: [["a", "a", "a", "a"]],
    seatOffsets: ["south"],
    teacher: { maxWork: 128, extensions: 0 },
    sampling: { every: 1, important: true, maxPositions: 2 },
    maxPlies: 3,
  };
}
const deterministic = { now: () => 0, yieldToHost: async () => {} };
function directory() {
  return mkdtempSync(join(tmpdir(), "four-shogi-data-test-"));
}
async function artifact() {
  const manifest = await createDataManifest({ ...config(), restrictions: [false] }, code);
  const plan = gamePlans(manifest)[0];
  const record = await generateSelfPlayGame(manifest, plan, null, async () => {}, deterministic);
  return { manifest, plan, record };
}

test("行動IDは全13446項目で一対一となり、成り/不成/移動/4種の打を区別する", () => {
  expect(actionSpaceSize).toBe(13446);
  for (let id = 0; id < actionSpaceSize; id++) expect(encodeAction(decodeAction(id))).toBe(id);
  expect(decodeAction(0)).toEqual({
    type: "movePiece",
    from: { x: 0, y: 0 },
    to: { x: 0, y: 0 },
    promote: false,
  });
  expect(decodeAction(1)).toEqual({
    type: "movePiece",
    from: { x: 0, y: 0 },
    to: { x: 0, y: 0 },
    promote: true,
  });
  for (const [index, kind] of (["rook", "gold", "silver", "pawn"] as const).entries())
    expect(decodeAction(13122 + index * 81)).toEqual({
      type: "dropPiece",
      pieceKind: kind,
      to: { x: 0, y: 0 },
    });
  for (const id of [-1, actionSpaceSize, 0.5, NaN, Infinity])
    expect(() => decodeAction(id)).toThrow();
  expect(() => legalActionMask([1, 1])).toThrow("重複");
  expect(() => legalActionMask([actionSpaceSize])).toThrow();
});

test("4方向の座標対応と正本の合法手マスクを、既存棋譜の移動/成り/打で復元する", async () => {
  const pawn = {
    type: "movePiece" as const,
    from: { x: 4, y: 7 },
    to: { x: 4, y: 6 },
    promote: false,
  };
  expect(sides.map((side) => encodeAction(rotateAction(pawn, side)))).toEqual([
    10970, 6070, 2150, 7050,
  ]);
  expect(encodeAction({ ...pawn, promote: true })).toBe(10971);
  expect(decodeAction(13445)).toEqual({ type: "dropPiece", pieceKind: "pawn", to: { x: 8, y: 8 } });
  expect(rotateAction(pawn, "west")).toEqual({
    type: "movePiece",
    from: { x: 1, y: 4 },
    to: { x: 2, y: 4 },
    promote: false,
  });
  let turned = pawn;
  for (let i = 0; i < 4; i++) turned = rotateAction(turned, "west") as typeof pawn;
  expect(turned).toEqual(pawn);
  const actors = new Set<Side>();
  for (const restricted of [false, true])
    for (const offset of [0, 1, 2, 3, 49, 60, 80, 99, 101]) {
      const position = await restoreAnalysisPosition({
        ...replay(archive.events, offset),
        initial: { ...initial, threePlayerAttackProhibited: restricted },
      });
      const legal = getAnalysisLegalActions(position);
      const ids = legal.map(encodeAction),
        mask = legalActionMask(ids);
      expect(ids.map(decodeAction)).toEqual([...legal]);
      expect([...mask].reduce((a, b) => a + b, 0)).toBe(legal.length);
      expect(mask[0]).toBe(0);
      if (position.state.turn) actors.add(position.state.turn);
    }
  expect([...actors].sort()).toEqual([...sides].sort());
});

test("分割は系列seedに固定され、ON/OFFと同一相手の席替えを二重生成しない", async () => {
  expect([18900, 58900, 68900, 78900].map(splitForSeed)).toEqual([
    "train",
    "validation",
    "calibration",
    "test",
  ]);
  expect(() => splitForSeed(100000)).toThrow();
  const manifest = await createDataManifest(
    {
      ...config(),
      seatOffsets: [...sides],
      origins: [18900, 58900, 68900, 78900].map((seed) => ({ seed })),
    },
    code,
  );
  expect(gamePlans(manifest)).toHaveLength(8);
  for (const origin of [0, 1, 2, 3]) {
    const starts = manifest.starts.filter((s) => s.origin === origin);
    expect(new Set(starts.map((s) => s.familyId)).size).toBe(1);
    expect(new Set(starts.map((s) => s.stateHash)).size).toBe(2);
  }
  await expect(
    createDataManifest({ ...config(), teacher: { timeBudgetMs: 1 } }, code),
  ).rejects.toThrow("壁時計");
  await expect(
    createDataManifest({ ...config(), teacher: { modelId: "missing-model" } }, code),
  ).rejects.toThrow();
});

test("同じ元棋譜の別手数/途中ファイルが別splitへ漏れることを検出する", async () => {
  const first = { seed: 18900, replay: replay(archive.events, 90) };
  await expect(
    createDataManifest(
      { ...config(), origins: [first, { seed: 58900, replay: replay(archive.events, 92) }] },
      code,
    ),
  ).rejects.toThrow("split");
  await expect(
    createDataManifest(
      {
        ...config(),
        origins: [first, { seed: 58900, replay: replay(archive.events.slice(0, 92), 92) }],
      },
      code,
    ),
  ).rejects.toThrow("split");
});

test("回転した盤面/持駒/実手番を同じ漏れ検査の族とし、履歴は完全状態で別に保持する", async () => {
  const position = await restoreAnalysisPosition(replay(archive.events, 60));
  const state = position.state;
  if (state.status !== "playing") throw new Error("継続局面が必要です");
  const rotateSide = (side: Side) => sides[(sides.indexOf(side) + 1) % 4];
  const board = state.board.map((row) =>
    row.map(() => null),
  ) as FourShogiState["board"][number][number][][];
  for (let y = 0; y < 9; y++)
    for (let x = 0; x < 9; x++) {
      const piece = state.board[y][x],
        to = positionForSide({ x, y }, "west");
      board[to.y][to.x] = piece ? { ...piece, side: rotateSide(piece.side) } : null;
    }
  const rotated = {
    ...state,
    board,
    hands: Object.fromEntries(
      sides.map((side) => [rotateSide(side), state.hands[side]]),
    ) as FourShogiState["hands"],
    turn: rotateSide(state.turn),
    eliminations: state.eliminations.map((e) => ({ ...e, side: rotateSide(e.side) })),
  } as FourShogiState;
  expect(positionFamilyKey(rotated)).toBe(positionFamilyKey(state));
  expect(positionFamilyKey({ ...state, threePlayerAttackProhibited: false })).toBe(
    positionFamilyKey(state),
  );
});

test("1手確定直後の中断から再開しても、全イベント/教師/状態が連続生成と一致する", async () => {
  const { manifest, plan, record: full } = await artifact();
  let saved: GameArtifact | null = null;
  await expect(
    generateSelfPlayGame(
      manifest,
      plan,
      null,
      async (record) => {
        saved = structuredClone(record);
        if (record.actors.length === 1)
          throw new GenerationPaused("test-interruption-after-commit");
      },
      deterministic,
    ),
  ).rejects.toThrow("test-interruption");
  expect(saved!.status).toBe("in_progress");
  expect(saved!.outcome).toBeNull();
  const resumed = await generateSelfPlayGame(manifest, plan, saved, async () => {}, deterministic);
  expect(resumed).toEqual(full);
  expect(resumed.status).toBe("truncated");
  expect(resumed.outcome).toBeNull();
  await validateGameArtifact(manifest, plan, resumed);
});

test("固定棋譜の単独勝者/同率終局を5分類で区別し、未終局はValue教師にしない", async () => {
  const won = await restoreAnalysisPosition(replay(archive.events));
  expect(outcomeFor(won)?.target).toEqual([0, 0, 1, 0, 0]);
  const drawn = await restoreAnalysisPosition(replay(draw.events));
  expect(outcomeFor(drawn)?.target).toEqual([0, 0, 0, 0, 1]);
  const live = await restoreAnalysisPosition(replay(archive.events, 99));
  expect(outcomeFor(live)).toBeNull();
});

test("教師の版/予算、合法手マスク、打切りラベルの混在を個別に拒否する", async () => {
  const { manifest, plan, record } = await artifact();
  await validateGameArtifact(manifest, plan, record);
  const version = structuredClone(record);
  (version.samples[0].teacher.versions as { searchVersion: string }).searchVersion =
    "wrong-version";
  await expect(validateGameArtifact(manifest, plan, version)).rejects.toThrow("混在");
  const mask = structuredClone(record);
  mask.samples[0].legalActionIds.push(0);
  await expect(validateGameArtifact(manifest, plan, mask)).rejects.toThrow("マスク");
  const labels = structuredClone(record);
  labels.status = "finished";
  await expect(validateGameArtifact(manifest, plan, labels)).rejects.toThrow("結果");
  const budget = structuredClone(record);
  (budget.samples[0].teacher.settings as { maxWork: number }).maxWork++;
  await expect(validateGameArtifact(manifest, plan, budget)).rejects.toThrow("混在");
});

test("MCTS教師の試行平均とPV末尾を保存し、ON/OFF双方で正本を再生できる", async () => {
  const manifest = await createDataManifest(
    { ...config(), teacher: { algorithm: "mcts", maxWork: 1024, seed: 189 }, maxPlies: 1 },
    code,
  );
  for (const plan of gamePlans(manifest)) {
    const record = await generateSelfPlayGame(manifest, plan, null, async () => {}, deterministic);
    expect(record.samples[0].teacher.versions.seed).toBe(189);
    expect(record.samples[0].teacher.candidates[0].comparisonKind).toBe("sample_mean");
    expect(record.samples[0].teacher.evaluation?.probabilities).toBeNull();
    await validateGameArtifact(manifest, plan, record);
  }
});

test("容量上限では前のcheckpointを残し、不完全な一時ファイルを採用しない", async () => {
  const { manifest, plan, record } = await artifact();
  const path = directory();
  try {
    let first: GameArtifact | null = null;
    await expect(
      generateSelfPlayGame(
        manifest,
        plan,
        null,
        async (value) => {
          first = structuredClone(value);
          throw new GenerationPaused("stop");
        },
        deterministic,
      ),
    ).rejects.toThrow("stop");
    let store = new SelfPlayStore(path, 8 * 1024 ** 2);
    store.writeManifest(manifest);
    store.writeGame(first!);
    const bytes = store.bytes();
    store.close();
    const nextBytes = Buffer.byteLength(
      JSON.stringify({ checksum: dataHash(record), payload: record }) + "\n",
    );
    writeFileSync(join(path, ".tmp-00000000-0000-0000-0000-000000000000"), "{unfinished");
    store = new SelfPlayStore(path, bytes + nextBytes - 1);
    try {
      expect(() => store.writeGame(record)).toThrow("byte_limit");
      expect(store.readGame(plan.gameId)).toEqual(first);
      expect(readdirSync(path).some((n) => n.startsWith(".tmp-"))).toBe(false);
    } finally {
      store.close();
    }
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});

test("親プロセスの強制終了後も、原子的に保存した局からCLIを再開できる", async () => {
  const path = directory(),
    fixture = directory();
  const configPath = join(fixture, "config.json");
  writeFileSync(configPath, JSON.stringify({ ...config(), maxPlies: 64 }));
  let child: Bun.Subprocess | null = null;
  let resolveCheckpoint = () => {};
  const checkpoint = new Promise<void>((resolve) => {
    resolveCheckpoint = resolve;
  });
  const watcher = watch(path, (_event, name) => {
    if (name && /^[0-9a-f]{64}\.json$/.test(String(name))) resolveCheckpoint();
  });
  try {
    const spawned = Bun.spawn({
      cmd: [
        process.execPath,
        join(import.meta.dir, "../bench/selfPlayCli.ts"),
        `--output=${path}`,
        `--config=${configPath}`,
        "--allow-dirty=true",
        "--max-games=2",
      ],
      stdout: "ignore",
      stderr: "pipe",
    });
    child = spawned;
    const stderr = new Response(spawned.stderr).text();
    await Promise.race([
      checkpoint,
      child.exited.then(async () => {
        throw new Error("checkpoint前にCLIが終了: " + (await stderr));
      }),
    ]);
    child.kill("SIGKILL");
    await child.exited;
    const resumed = await runSelfPlayDataset(path, undefined, {
      allowDirty: true,
      maxGames: 2,
      maxBytes: 16 * 1024 ** 2,
    });
    expect(resumed.complete).toBe(true);
    expect(resumed.finished + resumed.truncated).toBe(2);
    expect(resumed.positions).toBeGreaterThan(0);
    expect(resumed.positions).toBeLessThanOrEqual(128);
    expect(readdirSync(path).some((n) => n.startsWith(".tmp-") || n.includes("lock"))).toBe(false);
  } finally {
    watcher.close();
    child?.kill();
    if (child) await child.exited;
    rmSync(path, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
}, 10000);

test("checksum破損と生存中の二重実行を拒否し、終了済み所有者のロックを回復する", async () => {
  const path = directory();
  try {
    const release = lockDataset(path);
    expect(() => lockDataset(path)).toThrow("使用中");
    release();
    symlinkSync("2147483647:00000000-0000-0000-0000-000000000000", join(path, ".generation-lock"));
    const unlock = lockDataset(path);
    expect(readlinkSync(join(path, ".generation-lock")).startsWith(process.pid + ":")).toBe(true);
    unlock();
    const { manifest, plan, record } = await artifact();
    const store = new SelfPlayStore(path, 8 * 1024 ** 2);
    try {
      store.writeManifest(manifest);
      store.writeGame(record);
      const file = join(path, plan.gameId + ".json"),
        body = JSON.parse(readFileSync(file, "utf8"));
      body.payload.stateHash = "bad";
      writeFileSync(file, JSON.stringify(body));
      expect(() => store.readGame(plan.gameId)).toThrow("checksum");
    } finally {
      store.close();
    }
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});

test("dataset以外の出力先は拒否し、既存の一時ファイルも削除しない", () => {
  const path = directory();
  try {
    const file = join(path, ".tmp-00000000-0000-0000-0000-000000000000");
    writeFileSync(file, "unrelated");
    expect(() => new SelfPlayStore(path, 1024 ** 2)).toThrow("初期化");
    expect(readFileSync(file, "utf8")).toBe("unrelated");
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});

test("実プロセスの並列生成を途中停止/再開でき、完了済みゲームを再採用しない", async () => {
  const path = directory();
  const serialPath = directory();
  try {
    const options = { allowDirty: true, concurrency: 2, maxGames: 2, maxBytes: 8 * 1024 ** 2 };
    const paused = await runSelfPlayDataset(path, config(), { ...options, stopAfterMoves: 2 });
    expect(paused.stopReason).toBe("move_limit");
    expect(paused.observed.committedMoves).toBe(2);
    expect(paused.complete).toBe(false);
    expect(paused.observed.peakWorkers).toBe(2);
    const resumed = await runSelfPlayDataset(path, undefined, options);
    expect(resumed.complete).toBe(true);
    expect(resumed.truncated).toBe(2);
    expect(resumed.positions).toBe(6);
    expect(resumed.valueSamples).toBe(0);
    const repeated = await runSelfPlayDataset(path, undefined, options);
    expect(repeated.observed.committedMoves).toBe(0);
    expect(repeated.throughput.completedRecordsPerHour).toBe(0);
    expect(repeated.contentHash).toBe(resumed.contentHash);
    await expect(runSelfPlayDataset(path, { ...config(), maxPlies: 4 }, options)).rejects.toThrow(
      "不一致",
    );
    const store = new SelfPlayStore(path, options.maxBytes);
    let traces: {
      id: string;
      events: GameArtifact["replay"]["events"];
      stateHash: string;
      policy: (number | null)[];
    }[] = [];
    try {
      expect((await inspectDataStore(store)).complete).toBe(true);
      traces = store
        .gameIds()
        .sort()
        .map((id) => {
          const r = store.readGame(id)!;
          return {
            id,
            events: r.replay.events,
            stateHash: r.stateHash,
            policy: r.samples.map((s) => s.policyActionId),
          };
        });
    } finally {
      store.close();
    }
    const serial = await runSelfPlayDataset(serialPath, config(), { ...options, concurrency: 1 });
    expect(serial.observed.peakWorkers).toBe(1);
    const serialStore = new SelfPlayStore(serialPath, options.maxBytes);
    try {
      expect(
        serialStore
          .gameIds()
          .sort()
          .map((id) => {
            const r = serialStore.readGame(id)!;
            return {
              id,
              events: r.replay.events,
              stateHash: r.stateHash,
              policy: r.samples.map((s) => s.policyActionId),
            };
          }),
      ).toEqual(traces);
    } finally {
      serialStore.close();
    }
  } finally {
    rmSync(path, { recursive: true, force: true });
    rmSync(serialPath, { recursive: true, force: true });
  }
}, 10000);

test("メモリ/計画件数の上限で生成を止め、未生成データを完了にしない", async () => {
  expect(() => resolveGenerationLimits({ concurrency: 5 })).toThrow();
  const path = directory();
  try {
    await expect(
      runSelfPlayDataset(path, config(), { allowDirty: true, maxGames: 1 }),
    ).rejects.toThrow("件数");
    const result = await runSelfPlayDataset(
      path,
      config(),
      { allowDirty: true, maxGames: 2 },
      { readRss: () => 2 * 1024 ** 3 },
    );
    expect(result.stopReason).toBe("memory_limit");
    expect(result.pending).toBe(2);
    expect(result.observed.peakWorkers).toBe(0);
    expect(result.valueSamples).toBe(0);
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});
