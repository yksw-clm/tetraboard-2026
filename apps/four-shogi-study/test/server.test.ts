import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLegalActions } from "@tetraboard/four-shogi";
import { createStudyRootSearch, evaluateStudyPosition } from "@tetraboard/four-shogi/study-search";
import type { StudySnapshot } from "../src/contracts";
import { StudyStore } from "../src/domain/store";
import { restoreStudyPosition } from "../src/domain/study";
import { createStudySearchRuntime, type StudySearchSnapshot } from "../src/search/runtime";
import { LocalStudyApplication } from "../src/server/application";
import { createStudyHttpHandler } from "../src/server/http";
import { publicMatchLocation } from "../src/server/publicImport";

const resources: { app: LocalStudyApplication; directory: string }[] = [];
afterEach(async () => {
  for (const { app, directory } of resources.splice(0)) {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function harness(factory = createStudySearchRuntime) {
  const directory = await mkdtemp(join(tmpdir(), "four-shogi-study-server-"));
  const config = {
    logicalCpus: 10,
    totalMemoryMb: 24576,
    defaultThreads: 1,
    defaultMemoryMb: 512,
    dataDirectory: directory,
  };
  const app = new LocalStudyApplication(new StudyStore(directory), config, factory);
  resources.push({ app, directory });
  const handler = createStudyHttpHandler(app, config, directory);
  const request = (path: string, body?: unknown, origin = "http://127.0.0.1:5198") =>
    handler(
      new Request(
        `http://127.0.0.1:5198${path}`,
        body === undefined
          ? {}
          : {
              method: "POST",
              headers: { "Content-Type": "application/json", Origin: origin },
              body: JSON.stringify(body),
            },
      ),
    );
  const create = async () =>
    (await (
      await request("/api/studies", { title: "検証", cpuSide: "east" })
    ).json()) as StudySnapshot;
  return { app, request, create, handler, directory };
}

describe("ローカル検討アプリのHTTPと保存", () => {
  test("同一オリジンだけが作成でき、並行した古い着手は拒否する", async () => {
    const { request, create, handler } = await harness();
    expect((await request("/api/studies", {}, "https://example.com")).status).toBe(403);
    expect((await handler(new Request("http://untrusted.example:5198/api/config"))).status).toBe(
      403,
    );
    const initial = await create();
    expect(initial.study.playEnabled).toBe(false);
    const command = {
      type: "action",
      expectedRevision: initial.study.revision,
      action: initial.legalActions[0],
    };
    const responses = await Promise.all([
      request(`/api/studies/${initial.study.id}/commands`, command),
      request(`/api/studies/${initial.study.id}/commands`, command),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const latest = (await (
      await request(`/api/studies/${initial.study.id}`)
    ).json()) as StudySnapshot;
    expect(latest.position.state.moveNumber).toBe(1);
    expect(latest.study.nodes).toHaveLength(2);
  });

  test("巻き戻し・分岐・出力・再入力で元の枝と完全なルール状態を保つ", async () => {
    const { request, create } = await harness();
    const initial = await create();
    const path = `/api/studies/${initial.study.id}/commands`;
    const first = (await (
      await request(path, { type: "action", expectedRevision: 0, action: initial.legalActions[0] })
    ).json()) as StudySnapshot;
    const selected = (await (
      await request(path, {
        type: "select",
        expectedRevision: first.study.revision,
        nodeId: initial.study.currentNodeId,
      })
    ).json()) as StudySnapshot;
    const second = (await (
      await request(path, {
        type: "action",
        expectedRevision: selected.study.revision,
        action: initial.legalActions[1],
      })
    ).json()) as StudySnapshot;
    expect(second.study.nodes).toHaveLength(3);
    expect(second.study.nodes.some((node) => node.id === first.study.currentNodeId)).toBe(true);
    const data = await (await request(`/api/studies/${initial.study.id}/export`)).json();
    const imported = (await (await request("/api/import", { data })).json()) as StudySnapshot;
    expect(imported.study.id).not.toBe(initial.study.id);
    expect(imported.position.stateHash).toBe(second.position.stateHash);
    expect(imported.study.nodes).toEqual(second.study.nodes);
    expect(imported.study.playEnabled).toBe(false);
  });

  test("編集は履歴をリセットした別の検討になり、元の棋譜が残る", async () => {
    const { request, create } = await harness();
    const initial = await create();
    const moved = (await (
      await request(`/api/studies/${initial.study.id}/commands`, {
        type: "action",
        expectedRevision: 0,
        action: initial.legalActions[0],
      })
    ).json()) as StudySnapshot;
    const { board, hands, turn, threePlayerAttackProhibited } = moved.position.state;
    const setup = {
      schemaVersion: 1,
      board: board.map((row) =>
        row.map((piece) =>
          piece ? { side: piece.side, kind: piece.kind, promoted: piece.promoted } : null,
        ),
      ),
      hands,
      turn,
      threePlayerAttackProhibited,
      eliminations: [],
    };
    const edited = (await (
      await request(`/api/studies/${initial.study.id}/commands`, {
        type: "setup",
        expectedRevision: moved.study.revision,
        setup,
      })
    ).json()) as StudySnapshot;
    expect(edited.study.id).not.toBe(initial.study.id);
    expect(edited.position.state.moveNumber).toBe(0);
    expect(edited.position.state.attackRelations).toEqual([]);
    expect(Object.values(edited.position.state.repetitions)).toEqual([1]);
    expect(
      ((await (await request(`/api/studies/${initial.study.id}`)).json()) as StudySnapshot).position
        .stateHash,
    ).toBe(moved.position.stateHash);
  });

  test("SSEは初期局面を送り、読み取り取消で購読を終了できる", async () => {
    const { request, create } = await harness();
    const initial = await create();
    const response = await request(`/api/events?studyId=${initial.study.id}`);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"type":"snapshot"');
    await reader.cancel();
  });

  test("巻き戻し後に終了したCPU探索を着手に使わない", async () => {
    let late: (() => void) | undefined;
    const factory: typeof createStudySearchRuntime = () => ({
      async start(input, _options, notify = () => {}) {
        const position = await restoreStudyPosition(input);
        const evaluation = evaluateStudyPosition(position);
        const progress: StudySearchSnapshot = {
          id: "test-search",
          stateHash: position.stateHash,
          analysisStateHash: position.stateHash,
          focus: null,
          rootSide: position.state.turn,
          status: "running",
          reason: null,
          elapsedMs: 0,
          completedDepth: 0,
          work: 0,
          nodes: 0,
          memoryBytes: 0,
          candidates: [],
          recommendedAction: null,
          analysisRecommendedAction: null,
          evaluation,
          staticEvaluation: evaluation,
          workers: 1,
          diagnostics: {
            searchVersion: "test",
            profile: "study",
            selectedRoots: 0,
            legalRoots: 0,
            safetyComplete: false,
          },
        };
        notify(progress);
        late = () =>
          notify({
            ...progress,
            status: "completed",
            completedDepth: 1,
            recommendedAction: getLegalActions(position.state)[0],
          });
        return progress.id;
      },
      get() {
        return null;
      },
      async pause() {},
      async resume() {},
      async cancel() {},
      async close() {},
    });
    const { app } = await harness(factory);
    const initial = await app.create({ cpuSide: "south" });
    const running = await app.command(initial.study.id, {
      type: "resumePlay",
      expectedRevision: 0,
    });
    expect(running.analysis?.status).toBe("running");
    const selected = await app.command(initial.study.id, {
      type: "select",
      expectedRevision: running.study.revision,
      nodeId: initial.study.currentNodeId,
    });
    late!();
    const latest = await app.get(initial.study.id);
    expect(latest.study.revision).toBe(selected.study.revision);
    expect(latest.position.state.moveNumber).toBe(0);
    expect(latest.study.playEnabled).toBe(false);
  });

  test("公開棋譜取り込みは既知のHTTPS棋譜だけを受け付ける", () => {
    expect(() =>
      publicMatchLocation("http://127.0.0.1:1234/matches/8da982eb-04e5-44a4-8964-850f1e23e6b5"),
    ).toThrow();
    expect(() =>
      publicMatchLocation(
        "https://tetraboard.net@evil.example/matches/8da982eb-04e5-44a4-8964-850f1e23e6b5",
      ),
    ).toThrow();
    expect(
      publicMatchLocation("https://tetraboard.net/matches/8da982eb-04e5-44a4-8964-850f1e23e6b5").id,
    ).toBe("8da982eb-04e5-44a4-8964-850f1e23e6b5");
  });

  test("有限検討の結果とコメントを保存し、読み筋を分岐してから再起動しても再生できる", async () => {
    const engine = controlledEngine();
    const { app, directory } = await harness(engine.factory);
    const initial = await app.create({});
    const configured = await app.command(initial.study.id, {
      type: "settings",
      expectedRevision: initial.study.revision,
      settings: { analysisTimeMs: 15000 },
    });
    await app.analyze(initial.study.id, {
      command: "start",
      expectedRevision: configured.study.revision,
    });
    expect(engine.budgets).toEqual([15000]);
    const saved = observed(app, (snapshot) => !!snapshot.study.analysisRecords?.root);
    engine.complete();
    const result = await saved;
    expect(result.analysis?.candidates.length).toBeGreaterThan(0);
    const commented = await app.command(initial.study.id, {
      type: "comment",
      expectedRevision: result.study.revision,
      nodeId: "root",
      comment: "右への王手を比較する",
    });
    const branch = await app.command(initial.study.id, {
      type: "variation",
      expectedRevision: commented.study.revision,
      analysisId: commented.analysis!.id,
      stateHash: commented.position.stateHash,
      candidateIndex: 0,
      plies: 1,
      lineSignature: JSON.stringify(
        commented
          .analysis!.candidates[0].line.slice(0, 1)
          .map(({ side, action }) => ({ side, action })),
      ),
    });
    expect(branch.position.state.moveNumber).toBe(1);
    expect(branch.study.nodes.find((node) => node.id === "root")?.comment).toBe(
      "右への王手を比較する",
    );
    await app.close();
    const config = {
      logicalCpus: 10,
      totalMemoryMb: 24576,
      defaultThreads: 1,
      defaultMemoryMb: 512,
      dataDirectory: directory,
    };
    const reopened = new LocalStudyApplication(new StudyStore(directory), config, engine.factory);
    resources.push({ app: reopened, directory });
    const stored = await reopened.get(initial.study.id);
    const root = await reopened.command(initial.study.id, {
      type: "select",
      expectedRevision: stored.study.revision,
      nodeId: "root",
    });
    expect(root.analysis?.saved?.searchVersion).toBeTruthy();
    expect(root.analysis?.candidates[0].line[0].action).toEqual(
      result.analysis?.candidates[0].line[0].action,
    );
    expect(root.study.nodes.find((node) => node.id === "root")?.comment).toBe(
      "右への王手を比較する",
    );
    const corrupt = JSON.parse(JSON.stringify(await reopened.export(initial.study.id)));
    corrupt.analysisRecords.root.stateHash = "different-state";
    await expect(reopened.import({ data: corrupt })).rejects.toThrow("一致");
    const corruptLine = JSON.parse(JSON.stringify(await reopened.export(initial.study.id)));
    corruptLine.analysisRecords.root.candidates[0].events[0].side = "west";
    await expect(reopened.import({ data: corruptLine })).rejects.toThrow();
    expect((await reopened.get(initial.study.id)).position.stateHash).toBe(root.position.stateHash);
  });

  test("表示後に候補の並びが変わっても選んだ読み筋へ分岐する", async () => {
    const engine = controlledEngine();
    const { app, create, request } = await harness(engine.factory);
    const initial = await create();
    const displayed = await app.analyze(initial.study.id, {
      command: "start",
      expectedRevision: initial.study.revision,
    });
    const selected = displayed.analysis!.candidates[0];
    const replacement = displayed.analysis!.candidates[1];
    expect(replacement.action).not.toEqual(selected.action);
    const lineSignature = JSON.stringify(
      selected.line.slice(0, 1).map(({ side, action }) => ({ side, action })),
    );
    engine.update((progress) => ({
      ...progress,
      candidates: [progress.candidates[1], progress.candidates[0], ...progress.candidates.slice(2)],
      recommendedAction: replacement.action,
      work: progress.work + 1,
      elapsedMs: progress.elapsedMs + 1,
    }));
    const updated = await app.get(initial.study.id);
    expect(updated.analysis!.candidates[0].action).toEqual(replacement.action);
    const response = await request(`/api/studies/${initial.study.id}/commands`, {
      type: "variation",
      expectedRevision: updated.study.revision,
      analysisId: displayed.analysis!.id,
      stateHash: displayed.position.stateHash,
      candidateIndex: 0,
      plies: 1,
      lineSignature,
    });
    expect(response.status).toBe(200);
    const branch = (await response.json()) as StudySnapshot;
    expect(branch.position.state.moveNumber).toBe(1);
    expect(branch.position.state.lastMove?.action).toEqual(selected.action);
    expect(branch.position.state.lastMove?.action).not.toEqual(replacement.action);
    expect(
      branch.study.nodes.find((node) => node.id === branch.study.currentNodeId)?.event,
    ).toEqual({ type: "action", side: selected.line[0].side, action: selected.action });
  });

  test("表示した読み筋のprefixが更新されたら409で拒否し局面と分岐を変えない", async () => {
    const engine = controlledEngine();
    const { app, create, request } = await harness(engine.factory);
    const initial = await create();
    const displayed = await app.analyze(initial.study.id, {
      command: "start",
      expectedRevision: initial.study.revision,
    });
    const selected = displayed.analysis!.candidates[0];
    const lineSignature = JSON.stringify(
      selected.line.slice(0, 1).map(({ side, action }) => ({ side, action })),
    );
    engine.update((progress) => ({
      ...progress,
      candidates: progress.candidates.slice(1),
      recommendedAction: progress.candidates[1].action,
      work: progress.work + 1,
      elapsedMs: progress.elapsedMs + 1,
    }));
    const updated = await app.get(initial.study.id);
    expect(
      updated.analysis!.candidates.every(
        (candidate) =>
          JSON.stringify(
            candidate.line.slice(0, 1).map(({ side, action }) => ({ side, action })),
          ) !== lineSignature,
      ),
    ).toBe(true);
    const response = await request(`/api/studies/${initial.study.id}/commands`, {
      type: "variation",
      expectedRevision: updated.study.revision,
      analysisId: displayed.analysis!.id,
      stateHash: displayed.position.stateHash,
      candidateIndex: 0,
      plies: 1,
      lineSignature,
    });
    expect(response.status).toBe(409);
    const unchanged = await app.get(initial.study.id);
    expect(unchanged.study.revision).toBe(updated.study.revision);
    expect(unchanged.study.nodes).toEqual(updated.study.nodes);
    expect(unchanged.position.stateHash).toBe(initial.position.stateHash);
    expect(unchanged.position.state.moveNumber).toBe(0);
  });

  test("全席CPUは席別の予算で連続着手し、結果保存による更新でも停止しない", async () => {
    const engine = controlledEngine();
    const { app } = await harness(engine.factory);
    const initial = await app.create({
      settings: {
        seats: {
          south: { controller: "cpu", thinkTimeMs: 1000 },
          west: { controller: "cpu", thinkTimeMs: 5000 },
          north: { controller: "cpu", thinkTimeMs: 15000 },
          east: { controller: "cpu", thinkTimeMs: 30000 },
        },
      },
    });
    await app.command(initial.study.id, { type: "resumePlay", expectedRevision: 0 });
    const moved = observed(
      app,
      (snapshot) =>
        snapshot.position.state.moveNumber === 1 && snapshot.analysis?.status === "running",
    );
    engine.complete();
    const first = await moved;
    expect(first.study.playEnabled).toBe(true);
    expect(engine.budgets).toEqual([1000, 5000]);
    const nextMove = observed(
      app,
      (snapshot) =>
        snapshot.position.state.moveNumber === 2 && snapshot.analysis?.status === "running",
    );
    engine.complete();
    const second = await nextMove;
    expect(second.study.analysisRecords?.root).toBeDefined();
    expect(second.study.playEnabled).toBe(true);
    expect(engine.budgets).toEqual([1000, 5000, 15000]);
  });
});

function observed(app: LocalStudyApplication, condition: (snapshot: StudySnapshot) => boolean) {
  return new Promise<StudySnapshot>((resolve) => {
    const unsubscribe = app.subscribe((event) => {
      if (event.type === "snapshot" && condition(event.snapshot)) {
        unsubscribe();
        resolve(event.snapshot);
      }
    });
  });
}
function controlledEngine() {
  const budgets: (number | null)[] = [];
  let finish: () => void = () => {
    throw new Error("探索を開始してください");
  };
  let update: (transform: (current: StudySearchSnapshot) => StudySearchSnapshot) => void = () => {
    throw new Error("探索を開始してください");
  };
  const factory: typeof createStudySearchRuntime = () => ({
    async start(input, options, notify = () => {}) {
      budgets.push(options.timeBudgetMs ?? null);
      const position = await restoreStudyPosition(input);
      const session = createStudyRootSearch(position, { profile: "baseline", maxDepth: 1 });
      while (session.depth < 1) session.step();
      const lane = session.snapshot();
      let progress: StudySearchSnapshot = {
        id: crypto.randomUUID(),
        stateHash: position.stateHash,
        analysisStateHash: position.stateHash,
        focus: null,
        rootSide: position.state.turn,
        status: "running",
        reason: null,
        elapsedMs: 1,
        completedDepth: 1,
        work: lane.stats.work,
        nodes: lane.stats.nodes,
        memoryBytes: 0,
        candidates: lane.candidates.slice(0, 3),
        recommendedAction: lane.candidates[0]?.action ?? null,
        analysisRecommendedAction: lane.candidates[0]?.action ?? null,
        evaluation: lane.candidates[0]?.evaluation ?? null,
        staticEvaluation: lane.staticEvaluation,
        workers: 1,
        diagnostics: {
          searchVersion: "test",
          profile: "baseline",
          selectedRoots: lane.candidates.length,
          legalRoots: lane.candidates.length,
          safetyComplete: false,
        },
      };
      session.dispose();
      notify(progress);
      update = (transform) => {
        progress = transform(structuredClone(progress));
        notify(progress);
      };
      finish = () => update((current) => ({ ...current, status: "completed", reason: "deadline" }));
      return progress.id;
    },
    get() {
      return null;
    },
    async pause() {},
    async resume() {},
    async cancel() {},
    async close() {},
  });
  return {
    factory,
    budgets,
    complete: () => finish(),
    update: (transform: (current: StudySearchSnapshot) => StudySearchSnapshot) => update(transform),
  };
}
