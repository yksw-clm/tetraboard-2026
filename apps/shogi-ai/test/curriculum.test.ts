import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  applyAction,
  createInitialState,
  eliminateSide,
  getLegalActions,
  setDrawProposal,
  sides,
} from "@tetraboard/four-shogi";
import { lv3Weights } from "@tetraboard/four-shogi/lv3";
import { aiModelSchema } from "@tetraboard/protocol/shogi-ai";
import {
  fitCurriculum,
  preferenceLoss,
  validateCurriculum,
  lessonJobs,
  type Curriculum,
  type Lesson,
  type CurriculumInput,
} from "../src/curriculum";
import { resolvedOutcome } from "../src/outcome";
import { AiStore, type Task } from "../src/store";
import { pairedInterval, type Sample } from "../src/statistics";
import { parseOptions, Trainer } from "../src/training";
import { openingPosition, seededRandom } from "../../../packages/four-shogi/bench/measurement";

const initial = () =>
  createInitialState({
    mode: "singles",
    players: { south: "s", west: "w", north: "n", east: "e" },
  });
test("調整だけは脱落時に確定順位を使い、他者の引分で敗者を引分扱いしません", () => {
  const result = eliminateSide(initial(), "south", "resigned");
  if (!result.ok) throw new Error("Fixture elimination failed");
  let state = result.state;
  expect(state.status).toBe("playing");
  const early = resolvedOutcome(state, "south", 1, 1, true)!;
  expect(early.rank).toBe(4);
  expect(early.termination).toBe("learner-eliminated");
  expect(resolvedOutcome(state, "south", 1, 1, false)).toBeNull();
  if (state.status !== "playing") throw new Error("Playing fixture required");
  state = { ...state, drawProposals: sides.filter((s) => s !== "south" && s !== state.turn) };
  const draw = setDrawProposal(state, state.turn, true);
  if (!draw.ok) throw new Error("Fixture draw failed");
  const final = resolvedOutcome(draw.state, "south", 1, 2, false)!;
  expect(final.rank).toBe(early.rank);
  expect(final.reward).toBe(early.reward);
  expect(final.draw).toBe(false);
  expect(final.termination).toBe("finished");
});
test("親の決定的な調整結果は条件一致時だけ再利用し、独立検証・重複標本へ流用しません", () => {
  const directory = mkdtempSync(join(tmpdir(), "shogi-reuse-")),
    store = new AiStore(directory);
  const task: Task = {
    id: "first",
    runId: "g1",
    modelId: "parent",
    opponentId: "opponent",
    profileId: "singles-restricted",
    seed: 1,
    seat: "south",
    maxPlies: 800,
    pool: "tune",
  };
  const sample: Sample = {
    seed: 1,
    seat: "south",
    rank: 2,
    reward: 2 / 3,
    draw: false,
    unfinished: false,
    plies: 100,
    termination: "finished",
  };
  try {
    store.addTask(task);
    store.finish(task.id, sample);
    const next = { ...task, id: "second", runId: "g2" };
    store.addTask(next);
    expect(store.reuseBaseline(next)).toBe(true);
    expect(store.task(next.id).task.cachedFrom).toBe(task.id);
    expect(store.task(next.id).result).toEqual(sample);
    for (const changed of [
      { pool: "test" as const },
      { seed: 2 },
      { seat: "west" as const },
      { opponentId: "other" },
      { maxPlies: 400 },
      { modelId: "other" },
    ]) {
      const mismatch = { ...next, ...changed, id: "mismatch" };
      expect(store.reuseBaseline(mismatch)).toBe(false);
    }
    const parent = Array.from({ length: 32 }, (_, i) => ({
      ...sample,
      seed: Math.floor(i / 4),
      seat: sides[i % 4],
    }));
    expect(pairedInterval([...parent, parent[0]], parent)).toBeNull();
    expect(pairedInterval(parent, [...parent, parent[0]])).toBeNull();
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
test("教師の選好から重みを提案し、未使用系列の悪化と集合混在を拒否します", () => {
  const root = initial(),
    actions = getLegalActions(root);
  const pawn = actions.find(
    (a) => a.type === "movePiece" && root.board[a.from.y][a.from.x]?.kind === "pawn",
  )!;
  const king = actions.find(
    (a) => a.type === "movePiece" && root.board[a.from.y][a.from.x]?.kind === "silver",
  )!;
  const p = applyAction(root, root.turn!, pawn),
    k = applyAction(root, root.turn!, king);
  if (!p.ok || !k.ok) throw new Error("Legal lesson required");
  const lesson: Lesson = {
    id: "lesson",
    group: "train1",
    profileId: "singles-restricted",
    split: "train",
    state: root,
    sourceHash: "b".repeat(64),
    teacherDepth: 3,
    studentDepth: 1,
    difficult: true,
    preferred: 0,
    alternatives: [
      { state: p.state, risk: 0 },
      { state: k.state, risk: 0 },
    ],
  };
  const curriculum: Curriculum = {
    version: 1,
    sourceHash: "a".repeat(64),
    sourceGamesHash: "b".repeat(64),
    studentWork: 128,
    teacherWork: 512,
    lessons: Array.from({ length: 12 }, (_, i) => ({
      ...lesson,
      id: String(i),
      group: i < 8 ? "train" + (i % 2) : "holdout",
      split: i < 8 ? "train" : "holdout",
    })),
  };
  const parent = aiModelSchema.parse({
    schemaVersion: 1,
    id: "parent",
    profileId: "singles-restricted",
    generation: 0,
    parentId: null,
    codeCommit: "test",
    sourceHash: curriculum.sourceHash,
    createdAt: 0,
    maxWork: 128,
    weights: lv3Weights,
  });
  const original = JSON.stringify(curriculum);
  validateCurriculum(curriculum, parent.sourceHash, 128);
  const fit = fitCurriculum(parent, curriculum);
  expect(fit.weights.length).toBeGreaterThan(0);
  expect(preferenceLoss(curriculum.lessons, fit.weights[0])).toBeLessThan(
    preferenceLoss(curriculum.lessons, parent.weights),
  );
  expect(fit.report.candidateHoldoutLoss!).toBeLessThanOrEqual(fit.report.baselineHoldoutLoss!);
  expect(JSON.stringify(curriculum)).toBe(original);
  expect(fitCurriculum(parent, { ...curriculum, lessons: [lesson] }).weights).toEqual([]);
  expect(() =>
    validateCurriculum({ ...curriculum, sourceHash: "c".repeat(64) }, parent.sourceHash, 128),
  ).toThrow("source/budget");
  expect(() =>
    validateCurriculum(
      { ...curriculum, lessons: [lesson, { ...lesson, split: "holdout" }] },
      parent.sourceHash,
      128,
    ),
  ).toThrow("leaks");
});
test("途中局面を再生し、同一開始系列の席と局面を同じ集合へ固定します", () => {
  const seed = 700,
    random = seededRandom(7),
    events: CurriculumInput["events"] = [];
  let state = openingPosition("singles", true, seed);
  for (let i = 0; i < 64 && state.status === "playing"; i++) {
    const actions = getLegalActions(state),
      action = actions[Math.floor(random() * actions.length)],
      side = state.turn;
    const r = applyAction(state, side, action);
    if (!r.ok) throw new Error("Replay fixture failed");
    events.push({ type: "action", side, action });
    state = r.state;
  }
  const task: Task = {
    id: "g1",
    runId: "run",
    modelId: "model",
    opponentId: "lv2",
    profileId: "singles-restricted",
    seed,
    seat: "south",
    maxPlies: 800,
    pool: "tune",
  };
  const games = sides.map((seat) => ({
    task: { ...task, seat },
    events,
    sourceHash: "a".repeat(64),
    codeCommit: "test",
  }));
  const jobs = lessonJobs(games, 32);
  expect(jobs.length).toBeGreaterThan(0);
  expect(new Set(jobs.map((j) => j.split)).size).toBe(1);
  expect(
    lessonJobs(
      games.map((g) => ({ ...g, task: { ...g.task, pool: "test" as const } })),
      32,
    ),
  ).toEqual([]);
  expect(() => parseOptions(["--ends-at", String(Date.now() + 86460000)])).toThrow();
  expect(
    parseOptions(["--curriculum", "lesson.json", "--ends-at", String(Date.now() - 1)]).curriculum,
  ).toBe("lesson.json");
});
test("方式を変えても検証済みモデルと試用の終了時刻を引き継ぎ、検証系列を再利用しません", async () => {
  const directory = mkdtempSync(join(tmpdir(), "shogi-inherit-")),
    previous = new AiStore(join(directory, "previous"));
  const deadline = Date.now() + 5000;
  for (const profileId of ["singles-restricted", "singles-unrestricted"] as const) {
    const model = aiModelSchema.parse({
      schemaVersion: 1,
      id: profileId + "-parent",
      profileId,
      generation: 0,
      parentId: null,
      codeCommit: "previous",
      sourceHash: "a".repeat(64),
      createdAt: 0,
      maxWork: 128,
      weights: { ...lv3Weights, kingRing: 60 },
    });
    await previous.saveModel(model);
    previous.set(`champion:${profileId}`, model.id);
    previous.db
      .query("INSERT INTO runs VALUES (?,?,?)")
      .run(profileId + "-old", profileId, JSON.stringify({ generation: 2 }));
  }
  previous.set("startedAt", Date.now() - 60000);
  previous.set("endsAt", deadline);
  previous.set("status", { learning: { games: 7 } });
  previous.close();
  const output = join(directory, "export");
  const exporter = Bun.spawn(
    [process.execPath, join(import.meta.dir, "../src/cli.ts"), "export", output],
    {
      env: { ...process.env, AI_DATA_DIR: join(directory, "previous") },
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  expect(await exporter.exited).toBe(0);
  const store = new AiStore(join(directory, "next")),
    trainer = new Trainer(store, {
      ...parseOptions([
        "--seconds",
        "30",
        "--workers",
        "1",
        "--work",
        "128",
        "--seeds",
        "1",
        "--max-plies",
        "4",
      ]),
      initialExport: output,
      minFreeBytes: 1,
    });
  try {
    await trainer.start();
    const status = trainer.snapshot();
    expect(status.learningEndsAt).toBe(deadline);
    expect(status.learning.training?.importedGames).toBe(7);
    expect(
      status.profiles.every(
        (p) => p.champion.weights.kingRing === 60 && p.champion.parentId?.endsWith("-parent"),
      ),
    ).toBe(true);
    expect(status.profiles.every((p) => p.run?.generation === 3)).toBe(true);
    expect(store.pending().every((t) => t.pool === "tune" || t.seed >= 1000003000)).toBe(true);
  } finally {
    await trainer.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 10000);
