import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advanceAnalysisPosition } from "@tetraboard/four-shogi/analysis";
import { createStudyRootSearch } from "@tetraboard/four-shogi/study-search";
import {
  createStudy,
  parseStudyDocument,
  restoreStudyPosition,
  studyPath,
  updateStudySettings,
} from "../src/domain/study";
import { StudyStore } from "../src/domain/store";
import { projectFocusPosition } from "../src/search/focus";
import {
  createStudySearchRuntime,
  type StudySearchOptions,
  type StudySearchSnapshot,
} from "../src/search/runtime";
import { LocalStudyApplication } from "../src/server/application";

const resources: { app: LocalStudyApplication; directory: string }[] = [];
afterEach(async () => {
  for (const { app, directory } of resources.splice(0)) {
    await app.close();
    await rm(directory, { force: true, recursive: true });
  }
});

async function harness(searchCacheEntries?: number) {
  const directory = await mkdtemp(join(tmpdir(), "study-focus-application-"));
  const starts: StudySearchOptions[] = [];
  let finish = () => {};
  let pause = () => {};
  let resume = () => {};
  const factory: typeof createStudySearchRuntime = () => ({
    async start(input, options, notify = () => {}) {
      starts.push(options);
      const source = await restoreStudyPosition(input);
      const projection = options.focusSide
        ? await projectFocusPosition(source, options.focusSide, {
            workPerPly: 1,
            timeBudgetMs: null,
          })
        : null;
      const position = projection?.position ?? source;
      const session = createStudyRootSearch(position, {
        profile: "baseline",
        maxDepth: 1,
        dangerWork: 0,
      });
      while (session.depth < 1) session.step();
      const lane = session.snapshot();
      const action = lane.candidates[0]?.action ?? null;
      const progress: StudySearchSnapshot = {
        id: crypto.randomUUID(),
        stateHash: source.stateHash,
        analysisStateHash: position.stateHash,
        focus:
          projection && options.focusSide
            ? {
                side: options.focusSide,
                status: projection.status,
                reason: projection.reason,
                sourceStateHash: source.stateHash,
                analysisStateHash: projection.analysisStateHash,
                prefix: projection.prefix,
                conditional: projection.prefix.length > 0,
                projectionElapsedMs: projection.elapsedMs,
                model: projection.model,
                result: projection.result,
              }
            : null,
        rootSide: position.state.turn,
        status: "running",
        reason: null,
        elapsedMs: 10,
        completedDepth: 1,
        work: lane.stats.work,
        nodes: lane.stats.nodes,
        memoryBytes: 0,
        candidates: lane.candidates,
        recommendedAction: projection?.prefix.length ? null : action,
        analysisRecommendedAction: action,
        evaluation: lane.candidates[0]?.evaluation ?? null,
        staticEvaluation: lane.staticEvaluation,
        workers: 1,
        diagnostics: {
          searchVersion: "focus-server-test",
          profile: "baseline",
          selectedRoots: lane.candidates.length,
          legalRoots: lane.candidates.length,
          safetyComplete: false,
        },
      };
      session.dispose();
      notify(progress);
      finish = () => notify({ ...progress, status: "completed" });
      pause = () => notify({ ...progress, status: "paused" });
      resume = () => notify({ ...progress, status: "running" });
      return progress.id;
    },
    get: () => null,
    async pause() {
      pause();
    },
    async resume() {
      resume();
    },
    async cancel() {},
    async close() {},
  });
  const store = new StudyStore(directory);
  const app = new LocalStudyApplication(
    store,
    {
      logicalCpus: 8,
      totalMemoryMb: 16384,
      defaultThreads: 1,
      defaultMemoryMb: 512,
      dataDirectory: directory,
      ...(searchCacheEntries === undefined ? {} : { searchCacheEntries }),
    },
    factory,
  );
  resources.push({ app, directory });
  return { app, store, starts, complete: () => finish() };
}

test("明示した探索キャッシュ上限をジョブ・診断・保存再読込へ保持する", async () => {
  const { app, store, starts, complete } = await harness(1024);
  const initial = await app.create({
    settings: { mode: "analysis", searchStrategy: "dual-continuations" },
  });
  await app.analyze(initial.study.id, {
    command: "start",
    expectedRevision: initial.study.revision,
  });
  expect(starts[0].cacheSize).toBe(1024);
  complete();
  await app.close();
  const saved = (await store.load(initial.study.id))!;
  expect(saved.analysisRecords?.[saved.currentNodeId].cacheSize).toBe(1024);
  const directory = join(store.directory, "analysis-traces", initial.study.id);
  const file = (await readdir(directory)).find((name) => name.endsWith(".json"))!;
  const { payload } = JSON.parse(await readFile(join(directory, file), "utf8"));
  expect(payload.conditions.cacheSize).toBe(1024);
  const invalid = JSON.parse(JSON.stringify(saved));
  invalid.analysisRecords[saved.currentNodeId].cacheSize = 1.5;
  await expect(parseStudyDocument(invalid)).rejects.toThrow("保存された解析結果");
});

test("探索キャッシュ未指定時は既存のメモリ依存の既定値を上書きしない", async () => {
  const { app, starts } = await harness();
  await app.create({ settings: { mode: "analysis", focusSide: "south" } });
  expect(starts[0]).not.toHaveProperty("cacheSize");
});

test("フォーカス席を保存し、旧保存ファイルは未指定として読み込む", async () => {
  const study = await createStudy();
  expect(study.settings.focusSide).toBeNull();
  const focused = updateStudySettings(study, { focusSide: "east" });
  const restored = await parseStudyDocument(JSON.parse(JSON.stringify(focused)));
  expect(restored.settings.focusSide).toBe("east");
  const legacy = JSON.parse(JSON.stringify(focused));
  delete legacy.settings.focusSide;
  expect((await parseStudyDocument(legacy)).settings.focusSide).toBeNull();
  const invalid = JSON.parse(JSON.stringify(focused));
  invalid.settings.focusSide = "center";
  await expect(parseStudyDocument(invalid)).rejects.toThrow("フォーカスする席");
});

for (const side of ["south", "west"] as const)
  test(`完成したフォーカスの思考を実局面・予測局面と開始時設定を分けて記録する: ${side}`, async () => {
    const { app, store, complete } = await harness();
    const initial = await app.create({
      settings: {
        mode: "analysis",
        focusSide: side,
        searchStrategy: "dual-continuations",
      },
    });
    complete();
    await app.close();
    const directory = join(store.directory, "analysis-traces", initial.study.id);
    const files = await readdir(directory).catch(() => []);
    expect(files.filter((name) => name.endsWith(".json"))).toHaveLength(1);
    const { payload, checksum } = JSON.parse(await readFile(join(directory, files[0]), "utf8"));
    expect(checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(payload.settings.focusSide).toBe(side);
    expect(payload.settings.searchStrategy).toBe("dual-continuations");
    expect(payload.conditions.timeBudgetMs).toBe(initial.study.settings.analysisTimeMs);
    expect(payload.analysis.status).toBe("completed");
    expect(payload.analysis.id).toBe(initial.analysis!.id);
    expect(payload.analysis.focus.conditional).toBe(side === "west");
    expect((await restoreStudyPosition(payload.input)).stateHash).toBe(initial.position.stateHash);
    expect(payload.analysis.analysisStateHash === payload.analysis.stateHash).toBe(
      side === "south",
    );
    expect(payload.analysis.candidates[0].line.length).toBeGreaterThan(0);
    expect(payload.analysis.candidates[0].evaluation).toBeDefined();
  });

test("局面変更で止めたフォーカスの思考も取消として記録し、完成扱いしない", async () => {
  const { app, store } = await harness();
  const initial = await app.create({
    settings: { mode: "analysis", focusSide: "west" },
  });
  await app.close();
  const directory = join(store.directory, "analysis-traces", initial.study.id);
  const files = await readdir(directory);
  expect(files).toHaveLength(1);
  const { payload } = JSON.parse(await readFile(join(directory, files[0]), "utf8"));
  expect(payload.analysis.status).toBe("cancelled");
  expect(payload.analysis.focus.conditional).toBe(true);
  expect(payload.analysis.recommendedAction).toBeNull();
  expect(payload.settings.focusSide).toBe("west");
});

test("未来の候補を直接採用せず、予測を含む完全な読み筋だけを合法な分岐へ追加する", async () => {
  const { app } = await harness();
  const initial = await app.create({
    settings: { mode: "analysis", focusSide: "west" },
  });
  const analysis = initial.analysis!;
  const prefix = analysis.focus!.prefix;
  const candidate = analysis.candidates[0];
  expect(analysis.focus?.side).toBe("west");
  expect(prefix.length).toBeGreaterThan(0);
  expect(analysis.stateHash).toBe(initial.position.stateHash);
  expect(analysis.analysisStateHash).not.toBe(initial.position.stateHash);
  expect(analysis.recommendedAction).toBeNull();
  await expect(
    app.analyze(initial.study.id, {
      command: "adopt",
      expectedRevision: initial.study.revision,
      analysisId: analysis.id,
      stateHash: analysis.stateHash,
      action: candidate.action,
    }),
  ).rejects.toMatchObject({ status: 409 });
  const command = {
    type: "variation" as const,
    expectedRevision: initial.study.revision,
    analysisId: analysis.id,
    stateHash: analysis.stateHash,
    candidateIndex: 0,
    plies: 1,
  };
  await expect(
    app.command(initial.study.id, {
      ...command,
      lineSignature: JSON.stringify(
        candidate.line.slice(0, 1).map(({ side, action }) => ({ side, action })),
      ),
    }),
  ).rejects.toMatchObject({ status: 409 });
  const steps = [...prefix, ...candidate.line.slice(0, 1)];
  const branched = await app.command(initial.study.id, {
    ...command,
    lineSignature: JSON.stringify(steps.map(({ side, action }) => ({ side, action }))),
  });
  let expected = initial.position;
  for (const step of steps)
    expected = await advanceAnalysisPosition(expected, {
      type: "action",
      side: step.side,
      action: step.action,
    });
  expect(branched.position.stateHash).toBe(expected.stateHash);
  expect(studyPath(branched.study)).toHaveLength(steps.length + 1);
  expect(branched.study.settings.focusSide).toBe("west");
  expect(branched.analysis?.focus?.sourceStateHash).toBe(branched.position.stateHash);
  expect(branched.study.analysisRecords).toBeUndefined();
});

test("実手番のフォーカス候補は直接採用でき、CPUの自動着手はフォーカスを使わない", async () => {
  const { app, starts } = await harness();
  const initial = await app.create({
    settings: { mode: "analysis", focusSide: "south" },
  });
  expect(initial.analysis?.focus?.prefix).toHaveLength(0);
  const adopted = await app.analyze(initial.study.id, {
    command: "adopt",
    expectedRevision: initial.study.revision,
    analysisId: initial.analysis!.id,
    stateHash: initial.position.stateHash,
  });
  expect(adopted.position.state.moveNumber).toBe(1);
  const selected = await app.command(adopted.study.id, {
    type: "select",
    expectedRevision: adopted.study.revision,
    nodeId: "root",
  });
  const settings = await app.command(selected.study.id, {
    type: "settings",
    expectedRevision: selected.study.revision,
    settings: {
      mode: "auto",
      focusSide: "west",
      seats: {
        ...selected.study.settings.seats,
        south: { controller: "cpu", thinkTimeMs: 5000 },
      },
    },
  });
  const playing = await app.command(settings.study.id, {
    type: "resumePlay",
    expectedRevision: settings.study.revision,
  });
  expect(starts.at(-1)?.focusSide).toBeNull();
  expect(playing.analysis?.focus).toBeNull();
  expect(playing.study.settings.focusSide).toBe("west");
  const paused = await app.analyze(playing.study.id, {
    command: "pause",
    expectedRevision: playing.study.revision,
  });
  expect(paused.analysis?.status).toBe("paused");
  expect(paused.analysis?.focus).toBeNull();
  expect(paused.study.playEnabled).toBe(false);
  const resumed = await app.analyze(paused.study.id, {
    command: "resume",
    expectedRevision: paused.study.revision,
  });
  expect(resumed.analysis?.status).toBe("running");
  expect(resumed.analysis?.focus).toBeNull();
});

test("通常解析の保存結果をフォーカスへ流用せず、フォーカス結果で上書きしない", async () => {
  const { app, complete } = await harness();
  const created = await app.create({ settings: { mode: "analysis" } });
  await app.analyze(created.study.id, {
    command: "start",
    expectedRevision: 0,
  });
  const nextSaved = (focus: boolean) =>
    new Promise<void>((resolve) => {
      const unsubscribe = app.subscribe((event) => {
        if (
          event.type === "snapshot" &&
          event.snapshot.study.id === created.study.id &&
          !!event.snapshot.analysis?.focus === focus &&
          event.snapshot.analysis?.status === "completed"
        ) {
          unsubscribe();
          resolve();
        }
      });
    });
  const firstSaved = nextSaved(false);
  complete();
  await firstSaved;
  const normal = await app.get(created.study.id);
  const record = normal.study.analysisRecords?.root;
  expect(record).toBeDefined();
  const focused = await app.command(normal.study.id, {
    type: "settings",
    expectedRevision: normal.study.revision,
    settings: { focusSide: "east" },
  });
  expect(focused.analysis?.focus?.side).toBe("east");
  expect(focused.analysis?.saved).toBeUndefined();
  const focusFinished = nextSaved(true);
  complete();
  await focusFinished;
  const latest = await app.get(created.study.id);
  expect(latest.study.analysisRecords?.root).toEqual(record);
  const cleared = await app.command(latest.study.id, {
    type: "settings",
    expectedRevision: latest.study.revision,
    settings: { focusSide: null },
  });
  expect(cleared.analysis?.focus).toBeNull();
  expect(cleared.analysis?.saved?.savedAt).toBe(record!.savedAt);
});
