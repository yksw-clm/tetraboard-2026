import { afterEach, beforeEach, expect, test } from "bun:test";
import { StudyApp } from "../src/client/StudyApp";
import {
  act,
  enter,
  flush,
  press,
  render,
  requests,
  type Request as PendingRequest,
} from "../../web/test-dom/support";
import type {
  StudyAnalysisView,
  StudyServerEvent,
  StudySnapshot,
  StudyConfig,
} from "../src/contracts";
import {
  appendStudyEvent,
  createStudy,
  resolveStudyPositions,
  updateStudySettings,
  setStudyComment,
} from "../src/domain/study";
import type { StudyDocument, StudySettings } from "../src/shared/model";
import { getAnalysisLegalActions } from "@tetraboard/four-shogi/analysis";
import {
  createStudyRootSearch,
  evaluateStudyPosition,
  selectStudyRootIndices,
} from "@tetraboard/four-shogi/study-search";

class LocalEvents {
  static instances: LocalEvents[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    LocalEvents.instances.push(this);
  }
  close() {
    this.closed = true;
  }
  open() {
    act(() => this.onopen?.());
  }
  send(event: StudyServerEvent) {
    act(() => this.onmessage?.({ data: JSON.stringify(event) }));
  }
}
let eventSourceDescriptor: PropertyDescriptor | undefined;
const answered = new Set<PendingRequest>();
beforeEach(() => {
  answered.clear();
  LocalEvents.instances = [];
  eventSourceDescriptor = Object.getOwnPropertyDescriptor(globalThis, "EventSource");
  Object.defineProperty(globalThis, "EventSource", {
    configurable: true,
    writable: true,
    value: LocalEvents,
  });
});
afterEach(() => {
  if (eventSourceDescriptor)
    Object.defineProperty(globalThis, "EventSource", eventSourceDescriptor);
  else Reflect.deleteProperty(globalThis, "EventSource");
});
function request(path: string, method = "GET") {
  const value = requests.find(
    (entry) =>
      !answered.has(entry) && entry.url === path && (entry.init.method ?? "GET") === method,
  );
  if (!value) throw new Error(`未処理のHTTP要求がありません: ${method} ${path}`);
  answered.add(value);
  return value;
}
function library(snapshot: StudySnapshot) {
  return [
    {
      id: snapshot.study.id,
      title: snapshot.study.title,
      updatedAt: snapshot.study.updatedAt,
      cpuSide: snapshot.study.cpuSide,
    },
  ];
}
async function snapshot(
  study: StudyDocument,
  analysis: StudyAnalysisView | null = null,
): Promise<StudySnapshot> {
  const positions = await resolveStudyPositions(study);
  const position = positions.get(study.currentNodeId)!;
  const staticEvaluation = evaluateStudyPosition(position);
  return {
    study,
    position,
    legalActions: getAnalysisLegalActions(position),
    forbiddenActions: [],
    staticEvaluation,
    analysis,
    history: study.nodes.map((node) => ({
      id: node.id,
      parentId: node.parentId,
      label: node.parentId ? "分岐の着手" : "開始局面",
      moveNumber: positions.get(node.id)!.state.moveNumber,
      evaluation: evaluateStudyPosition(positions.get(node.id)!),
    })),
  };
}
async function initial() {
  return snapshot(
    await createStudy({
      id: "dom-study",
      title: "HTTPで開いた検討",
      settings: { mode: "analysis" },
      nowMs: 1793142000000,
    }),
  );
}
async function boot(current: StudySnapshot, models?: StudyConfig["models"]) {
  const view = render(<StudyApp />);
  request("/api/config").respond({
    logicalCpus: 10,
    totalMemoryMb: 24576,
    defaultThreads: 4,
    defaultMemoryMb: 8192,
    dataDirectory: "/tmp/study-dom",
    ...(models ? { models } : {}),
  });
  request("/api/studies").respond(library(current));
  await flush();
  request(`/api/studies/${current.study.id}`).respond(current);
  await flush();
  request("/api/studies").respond(library(current));
  await flush();
  LocalEvents.instances.at(-1)!.open();
  LocalEvents.instances.at(-1)!.send({ type: "snapshot", snapshot: current });
  await flush();
  return view;
}
async function finish(response: PendingRequest, next: StudySnapshot) {
  response.respond(next);
  await flush();
  request("/api/studies").respond(library(next));
  await flush();
}
function field(label: string) {
  const wrapper = [...document.querySelectorAll("label")].find(
    (entry) => entry.querySelector("span")?.textContent === label,
  );
  const control = wrapper?.querySelector<
    HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
  >("input,textarea,select");
  if (!control) throw new Error(`入力欄がありません: ${label}`);
  return control;
}
function select(label: string, value: string) {
  const control = field(label) as HTMLSelectElement;
  act(() => {
    control.value = value;
    control.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
function body(response: PendingRequest) {
  return JSON.parse(String(response.init.body)) as Record<string, unknown>;
}
function analysis(
  current: StudySnapshot,
  status: StudyAnalysisView["status"] = "running",
  generation = 1,
): StudyAnalysisView {
  const search = createStudyRootSearch(current.position, {
    maxDepth: 2,
    extensions: 0,
    width: 3,
    rootWidth: 5,
    dangerWork: 16,
  });
  try {
    while (search.depth < 1) search.step();
    search.setRootIndices(
      selectStudyRootIndices(search.snapshot().candidates, current.position.state.turn!, 5),
    );
    while (search.depth < 2 && !search.step()) {}
    const result = search.snapshot();
    return {
      id: "dom-analysis",
      nodeId: current.study.currentNodeId,
      stateHash: current.position.stateHash,
      generation,
      status,
      reason: null,
      elapsedMs: 1000,
      completedDepth: 2,
      work: result.stats.work,
      nodes: result.stats.nodes,
      memoryBytes: 1024 * 1024,
      candidates: result.candidates.slice(0, 3),
      recommendedAction: result.candidates[0].action,
      evaluation: result.candidates[0].evaluation,
    };
  } finally {
    search.dispose();
  }
}

test("完成反復の最善手をSSEで更新し、次の反復・停止・完了でも保持する", async () => {
  const current = await initial();
  const published = analysis(current);
  const comparison = (
    depth: number,
    alternate = false,
    status: StudyAnalysisView["status"] = "running",
  ) => {
    const candidates = [...published.candidates];
    if (alternate) [candidates[0], candidates[1]] = [candidates[1], candidates[0]];
    return {
      ...published,
      completedDepth: depth,
      status,
      work: depth * 1000,
      elapsedMs: depth * 100,
      candidates: depth
        ? candidates.map((candidate) => ({ ...candidate, completedDepth: depth }))
        : [],
      recommendedAction: candidates[0].action,
      analysisRecommendedAction: candidates[0].action,
      analysisStateHash: current.position.stateHash,
    };
  };
  const view = await boot(current);
  const events = LocalEvents.instances.at(-1)!;
  const count = requests.length;
  const arrow = () => view.querySelector<SVGSVGElement>('[data-testid="shogi-best-move"]');
  const coordinates = () =>
    [...arrow()!.querySelector("line")!.attributes]
      .filter((a) => ["x1", "y1", "x2", "y2"].includes(a.name))
      .map((a) => a.value);
  const send = async (next: StudyAnalysisView) => {
    events.send({ type: "analysis", studyId: current.study.id, analysis: next });
    await flush();
  };
  expect(arrow()).toBeNull();
  await send(comparison(0));
  expect(view.textContent).toContain("最善手を計算中");
  expect(arrow()).toBeNull();
  await send(comparison(1));
  expect(arrow()).not.toBeNull();
  expect(arrow()!.getAttribute("aria-label")).toContain("暫定最善手・深さ1まで完成");
  const first = coordinates();
  await send({ ...comparison(1), work: 1500, elapsedMs: 150 });
  expect(coordinates()).toEqual(first);
  await send(comparison(2, true));
  const second = coordinates();
  expect(second).not.toEqual(first);
  await send({ ...comparison(2, true), work: 2500, elapsedMs: 250 });
  expect(coordinates()).toEqual(second);
  await send(comparison(3, true));
  expect(coordinates()).toEqual(second);
  expect(arrow()!.getAttribute("aria-label")).toContain("深さ3まで完成");
  await send(comparison(3, true, "paused"));
  expect(coordinates()).toEqual(second);
  expect(arrow()!.getAttribute("aria-label")).toContain("停止中");
  await send(comparison(3, true, "completed"));
  expect(coordinates()).toEqual(second);
  expect(arrow()!.getAttribute("aria-label")).toContain("最善手（探索完了）");
  expect(requests).toHaveLength(count);
});

test("矢印は旧job・旧generation・別studyの通知を拒否し、再解析開始時に消える", async () => {
  const current = await initial();
  current.analysis = { ...analysis(current, "running", 2), id: "current-job" };
  const view = await boot(current);
  const events = LocalEvents.instances.at(-1)!;
  const arrow = () => view.querySelector('[data-testid="shogi-best-move"]');
  const original = arrow()!.getAttribute("aria-label");
  const alternate = current.analysis.candidates[1];
  const stale = {
    ...current.analysis,
    id: "old-job",
    recommendedAction: alternate.action,
    candidates: [alternate],
    work: 999999,
    elapsedMs: 999999,
  };
  events.send({
    type: "analysis",
    studyId: current.study.id,
    analysis: { ...stale, generation: 1 },
  });
  await flush();
  expect(arrow()!.getAttribute("aria-label")).toBe(original);
  events.send({
    type: "analysis",
    studyId: "different-study",
    analysis: { ...stale, generation: 99 },
  });
  await flush();
  expect(arrow()!.getAttribute("aria-label")).toBe(original);
  events.send({ type: "analysis", studyId: current.study.id, analysis: stale });
  await flush();
  expect(arrow()!.getAttribute("aria-label")).toBe(original);
  events.send({
    type: "analysis",
    studyId: current.study.id,
    analysis: {
      ...current.analysis,
      id: "new-job",
      generation: 3,
      completedDepth: 0,
      candidates: [],
      work: 0,
      elapsedMs: 0,
    },
  });
  await flush();
  expect(arrow()).toBeNull();
  events.send({ type: "analysis", studyId: current.study.id, analysis: current.analysis });
  await flush();
  expect(arrow()).toBeNull();
});

test("局面変更・異なる解析対象・条件付きフォーカスでは矢印を表示しない", async () => {
  const current = await initial();
  current.analysis = analysis(current, "completed");
  const view = await boot(current);
  const events = LocalEvents.instances.at(-1)!;
  const arrow = () => view.querySelector('[data-testid="shogi-best-move"]');
  expect(arrow()).not.toBeNull();
  const nextStudy = await appendStudyEvent(current.study, {
    type: "action",
    side: current.position.state.turn!,
    action: current.legalActions[0],
  });
  const next = await snapshot(nextStudy, current.analysis);
  events.send({ type: "snapshot", snapshot: next });
  await flush();
  expect(arrow()).toBeNull();
  events.send({
    type: "analysis",
    studyId: current.study.id,
    analysis: { ...current.analysis, generation: 99 },
  });
  await flush();
  expect(arrow()).toBeNull();
  const focused = {
    ...analysis(next, "running", 100),
    analysisStateHash: "future-hash",
    focus: {
      side: "south" as const,
      status: "ready" as const,
      sourceStateHash: next.position.stateHash,
      analysisStateHash: "future-hash",
      prefix: [],
      conditional: true,
      reason: null,
      projectionElapsedMs: 0,
      result: null,
      model: {
        version: "local-focus-projection-v1" as const,
        opponentModelId: "selfish-maxn-v1" as const,
        workPerPly: 1,
        maxPlies: 4,
        work: 0,
        decisions: [],
      },
    },
  };
  events.send({ type: "analysis", studyId: next.study.id, analysis: focused });
  await flush();
  expect(arrow()).toBeNull();
  expect(view.textContent).toContain("現在局面の最善手は未確認");
});

test("未完成根・手番違い・非合法な候補を隠し、現在手番のフォーカスだけを描画する", async () => {
  const current = await initial();
  const completed = analysis(current, "completed");
  current.analysis = completed;
  const view = await boot(current);
  const events = LocalEvents.instances.at(-1)!;
  const arrow = () => view.querySelector('[data-testid="shogi-best-move"]');
  const invalid: readonly ((value: StudyAnalysisView) => StudyAnalysisView)[] = [
    (value) => ({ ...value, analysisStateHash: "different-target" }),
    (value) => ({ ...value, nodeId: "different-node" }),
    (value) => ({ ...value, candidates: [{ ...value.candidates[0], completedDepth: 0 }] }),
    (value) => ({
      ...value,
      candidates: [
        { ...value.candidates[0], line: [{ ...value.candidates[0].line[0], side: "west" }] },
      ],
    }),
    (value) => ({ ...value, status: "cancelled" }),
    (value) => ({ ...value, status: "error" }),
  ];
  for (const [index, change] of invalid.entries()) {
    events.send({
      type: "snapshot",
      snapshot: {
        ...current,
        study: { ...current.study, revision: index + 1 },
        analysis: change({ ...completed, generation: index + 2, id: `invalid-${index}` }),
      },
    });
    await flush();
    expect(arrow()).toBeNull();
  }
  events.send({
    type: "snapshot",
    snapshot: {
      ...current,
      study: { ...current.study, revision: 10 },
      legalActions: current.legalActions.filter(
        (action) => JSON.stringify(action) !== JSON.stringify(completed.recommendedAction),
      ),
      analysis: { ...completed, id: "not-legal", generation: 10 },
    },
  });
  await flush();
  expect(arrow()).toBeNull();
  const focused: StudySnapshot = {
    ...current,
    study: { ...current.study, revision: 11 },
    analysis: {
      ...completed,
      id: "current-focus",
      generation: 11,
      analysisStateHash: current.position.stateHash,
      focus: {
        side: "south",
        status: "ready",
        conditional: false,
        prefix: [],
        sourceStateHash: current.position.stateHash,
        analysisStateHash: current.position.stateHash,
        reason: null,
        projectionElapsedMs: 0,
        model: null,
        result: null,
      },
    },
  };
  events.send({ type: "snapshot", snapshot: focused });
  await flush();
  expect(arrow()).not.toBeNull();
  press(view, "局面編集");
  await finish(request(`/api/studies/${current.study.id}/commands`, "POST"), {
    ...focused,
    study: { ...focused.study, revision: 12 },
  });
  expect(view.textContent).toContain("盤面を編集");
  expect(arrow()).toBeNull();
});

test("ローカル配信切断中はライブの旧候補を隠し、遅延snapshotでも再表示しない", async () => {
  const current = await initial();
  current.analysis = analysis(current, "completed");
  current.live = {
    sourceUrl: "https://tetraboard.net/rooms/12345",
    instanceId: "instance",
    roundId: "round",
    eventCount: 0,
    latestNodeId: current.study.currentNodeId,
    follow: true,
    status: "live",
    message: null,
  };
  const view = await boot(current);
  expect(view.textContent).toContain("この手を試す");
  expect(view.querySelector('[data-testid="shogi-best-move"]')).not.toBeNull();
  act(() => LocalEvents.instances.at(-1)!.onerror?.());
  await flush();
  expect(view.textContent).not.toContain("この手を試す");
  expect(view.querySelector('[data-testid="shogi-best-move"]')).toBeNull();
  LocalEvents.instances.at(-1)!.send({ type: "snapshot", snapshot: current });
  await flush();
  expect(view.textContent).not.toContain("この手を試す");
});

test("配信の再接続だけでは旧候補を戻さず、新しい初期snapshotを待つ", async () => {
  const current = await initial();
  current.analysis = analysis(current, "completed");
  current.live = {
    sourceUrl: "https://tetraboard.net/rooms/12345",
    instanceId: "instance",
    roundId: "round",
    eventCount: 0,
    latestNodeId: current.study.currentNodeId,
    follow: true,
    status: "live",
    message: null,
  };
  const view = await boot(current);
  const events = LocalEvents.instances.at(-1)!;
  act(() => events.onerror?.());
  await flush();
  events.open();
  await flush();
  expect(view.textContent).not.toContain("この手を試す");
  events.send({ type: "analysis", studyId: current.study.id, analysis: current.analysis! });
  await flush();
  expect(view.textContent).not.toContain("この手を試す");
  events.send({ type: "snapshot", snapshot: current });
  await flush();
  expect(view.textContent).toContain("この手を試す");
});

test("再接続後に古いrevisionの初期snapshotが届いても候補を表示しない", async () => {
  const original = await initial();
  const current = await snapshot(
    await appendStudyEvent(original.study, {
      type: "action",
      side: original.position.state.turn!,
      action: original.legalActions[0],
    }),
  );
  current.analysis = analysis(current, "completed");
  current.live = {
    sourceUrl: "https://tetraboard.net/rooms/12345",
    instanceId: "instance",
    roundId: "round",
    eventCount: 1,
    latestNodeId: current.study.currentNodeId,
    follow: true,
    status: "live",
    message: null,
  };
  const view = await boot(current);
  const events = LocalEvents.instances.at(-1)!;
  act(() => events.onerror?.());
  await flush();
  events.open();
  events.send({ type: "snapshot", snapshot: original });
  await flush();
  expect(view.textContent).not.toContain("この手を試す");
  events.send({ type: "analysis", studyId: current.study.id, analysis: current.analysis! });
  await flush();
  expect(view.textContent).not.toContain("この手を試す");
  events.send({ type: "snapshot", snapshot: current });
  await flush();
  expect(view.textContent).toContain("この手を試す");
});

test("新しい対局で各席の人間/CPUとCPU思考時間を指定して保存する", async () => {
  const current = await initial();
  const view = await boot(current);
  press(view, "＋ 新しい対局");
  await flush();
  expect((field("南の担当") as HTMLSelectElement).value).toBe("human");
  expect((field("西の担当") as HTMLSelectElement).value).toBe("cpu");
  select("西の担当", "human");
  select("東の担当", "human");
  enter(field("北CPUの思考時間（秒）") as HTMLInputElement, "12.5");
  enter(field("検討名") as HTMLInputElement, "一人のCPUと検討");
  const form = field("検討名").closest("form")!;
  act(() => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  const creation = request("/api/studies", "POST");
  const input = body(creation);
  expect(input).toMatchObject({
    title: "一人のCPUと検討",
    settings: {
      seats: {
        south: { controller: "human" },
        west: { controller: "human" },
        north: { controller: "cpu", thinkTimeMs: 12500 },
        east: { controller: "human" },
      },
    },
  });
  const next = await snapshot(
    await createStudy({
      id: "created-study",
      title: String(input.title),
      settings: input.settings as Partial<StudySettings>,
    }),
  );
  await finish(creation, next);
  expect(view.textContent?.includes("一人のCPUと検討")).toBe(true);
  expect(document.querySelector('[role="dialog"]') === null).toBe(true);
});

test("実在候補だけから評価世代を選び、P0-5へ切替え、旧モデルのSSEを拒否してG0へ戻せる", async () => {
  let current = await initial();
  const model = {
    id: "g001-candidate-night-0001",
    generation: 1,
    state: "candidate",
    modelId: "four-shogi-tiny-policy-value-v1:" + "1".repeat(64),
    createdAt: "2026-10-31T02:00:00Z",
    parentId: "g000",
    trainingSamples: 16,
    available: true,
    error: null,
    qualified: false,
    validation: {},
  };
  const view = await boot(current, [
    model,
    { ...model, id: "g001-candidate-broken", available: false, error: "checksum" },
  ]);
  press(view, "設定");
  await flush();
  const picker = field("評価モデル") as HTMLSelectElement;
  expect(
    picker.querySelector<HTMLOptionElement>('option[value="g001-candidate-broken"]')!.disabled,
  ).toBe(true);
  select("評価モデル", model.id);
  expect((field("探索方式") as HTMLSelectElement).value).toBe("dual-continuations");
  expect(document.body.textContent).toContain("データ品質は未達");
  act(() =>
    field("検討名")
      .closest("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  const saving = request(`/api/studies/${current.study.id}/commands`, "POST");
  expect(body(saving)).toMatchObject({
    settings: { modelGeneration: model.id, searchStrategy: "dual-continuations" },
  });
  current = await snapshot(
    updateStudySettings(current.study, body(saving).settings as Partial<StudySettings>),
  );
  await finish(saving, current);
  LocalEvents.instances.at(-1)!.send({
    type: "analysis",
    studyId: current.study.id,
    analysis: { ...analysis(current, "completed", 999), nodes: 987654 },
  });
  await flush();
  expect(view.textContent).not.toContain("987,654");
  press(view, "設定");
  await flush();
  select("評価モデル", "g000");
  act(() =>
    field("検討名")
      .closest("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  const fallback = request(`/api/studies/${current.study.id}/commands`, "POST");
  current = await snapshot(
    updateStudySettings(current.study, body(fallback).settings as Partial<StudySettings>),
  );
  await finish(fallback, current);
  expect(current.study.settings.modelGeneration).toBeUndefined();
});

test("検討時間をプリセットと無制限に変更し、探索の停止/再解析をHTTPへ伝える", async () => {
  let current = await initial();
  const view = await boot(current);
  press(view, "設定");
  await flush();
  press(document.body, "15秒");
  const strategy = field("探索方式") as HTMLSelectElement;
  act(() => {
    strategy.value = "dual-refined";
    strategy.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect((field("1回の検討時間（秒）") as HTMLInputElement).value).toBe("15");
  const continuous = [
    ...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
  ].find((input) => input.closest("label")?.textContent?.includes("停止するまで"))!;
  act(() => continuous.click());
  expect((field("1回の検討時間（秒）") as HTMLInputElement).disabled).toBe(true);
  act(() =>
    field("検討名")
      .closest("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  const settings = request(`/api/studies/${current.study.id}/commands`, "POST");
  expect(body(settings)).toMatchObject({
    type: "settings",
    expectedRevision: 0,
    settings: { analysisTimeMs: null, searchStrategy: "dual-refined" },
  });
  current = await snapshot(
    updateStudySettings(current.study, body(settings).settings as Partial<StudySettings>),
  );
  await finish(settings, current);
  press(view, "この局面を検討");
  const starting = request(`/api/studies/${current.study.id}/analysis`, "POST");
  expect(body(starting).command).toBe("start");
  const running = analysis(current);
  current = { ...current, analysis: running };
  await finish(starting, current);
  press(view, "探索を停止");
  const pausing = request(`/api/studies/${current.study.id}/analysis`, "POST");
  expect(body(pausing).command).toBe("pause");
  current = { ...current, analysis: { ...running, status: "paused" } };
  await finish(pausing, current);
  press(view, "再解析");
  const resuming = request(`/api/studies/${current.study.id}/analysis`, "POST");
  expect(body(resuming).command).toBe("start");
  await finish(resuming, { ...current, analysis: { ...running, generation: 2 } });
  expect(view.textContent?.includes("思考中")).toBe(true);
});

test("候補PVから分岐し、別局面のSSEと古いHTTP応答で表示を巻き戻さない", async () => {
  const initialSnapshot = await initial();
  const completed = analysis(initialSnapshot, "completed", 3);
  const current = { ...initialSnapshot, analysis: completed };
  const view = await boot(current);
  expect(view.textContent?.includes("予想手順・危険の確認")).toBe(true);
  const events = LocalEvents.instances.at(-1)!;
  events.send({
    type: "analysis",
    studyId: current.study.id,
    analysis: { ...completed, generation: 2, completedDepth: 99, nodes: 999999 },
  });
  await flush();
  expect(view.textContent?.includes("999,999")).toBe(false);
  const pvButton = [...view.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
    button.textContent?.includes("ここまで盤面で確認"),
  )!;
  act(() => pvButton.click());
  const variation = request(`/api/studies/${current.study.id}/commands`, "POST");
  expect(body(variation)).toMatchObject({
    type: "variation",
    analysisId: completed.id,
    stateHash: current.position.stateHash,
    candidateIndex: 0,
    plies: 1,
  });
  const nextStudy = await appendStudyEvent(current.study, {
    type: "action",
    side: current.position.state.turn!,
    action: completed.candidates[0].action,
  });
  const next = await snapshot(nextStudy);
  await finish(variation, next);
  expect(view.textContent?.includes("1手目")).toBe(true);
  press(view, "この局面を検討");
  const oldResponse = request(`/api/studies/${next.study.id}/analysis`, "POST");
  const latestStudy = await appendStudyEvent(next.study, {
    type: "action",
    side: next.position.state.turn!,
    action: next.legalActions[0],
  });
  const latest = await snapshot(latestStudy);
  events.send({ type: "snapshot", snapshot: latest });
  await flush();
  events.send({
    type: "analysis",
    studyId: next.study.id,
    analysis: { ...completed, generation: 99, nodes: 999999 },
  });
  await finish(oldResponse, next);
  expect(view.textContent?.includes("2手目")).toBe(true);
  expect(view.textContent?.includes("999,999")).toBe(false);
});

test("局面のコメントを保存し、ライブ観戦の追従/固定を切り替える", async () => {
  let current = await initial();
  current = {
    ...current,
    live: {
      sourceUrl: "https://tetraboard.net/rooms/12345?instanceId=test",
      instanceId: "test",
      roundId: "round-1",
      eventCount: 0,
      latestNodeId: current.study.currentNodeId,
      follow: true,
      status: "live",
      message: null,
    },
  };
  const view = await boot(current);
  enter(field("検討メモ") as HTMLTextAreaElement, "右王への王手を比較する");
  act(() =>
    field("検討メモ")
      .closest("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  const commenting = request(`/api/studies/${current.study.id}/commands`, "POST");
  expect(body(commenting)).toMatchObject({
    type: "comment",
    nodeId: current.study.currentNodeId,
    comment: "右王への王手を比較する",
  });
  current = {
    ...current,
    ...(await snapshot(
      setStudyComment(current.study, current.study.currentNodeId, "右王への王手を比較する"),
    )),
  };
  await finish(commenting, current);
  press(view, "局面を固定");
  const holding = request(`/api/studies/${current.study.id}/commands`, "POST");
  expect(body(holding)).toMatchObject({ type: "liveFollow", enabled: false });
  current = { ...current, live: { ...current.live!, follow: false } };
  await finish(holding, current);
  expect(view.textContent?.includes("局面を固定して検討")).toBe(true);
  press(view, "最新局面に追従");
  const following = request(`/api/studies/${current.study.id}/commands`, "POST");
  expect(body(following)).toMatchObject({ type: "liveFollow", enabled: true });
  await finish(following, { ...current, live: { ...current.live!, follow: true } });
  expect(view.textContent?.includes("最新局面に追従")).toBe(true);
});

test("ライブ観戦の席フォーカスを保存し、最新局面への追従を維持する", async () => {
  const original = await initial();
  const current: StudySnapshot = {
    ...original,
    live: {
      sourceUrl: "https://tetraboard.net/rooms/12345?instanceId=test",
      instanceId: "test",
      roundId: "round-1",
      eventCount: 0,
      latestNodeId: original.study.currentNodeId,
      follow: true,
      status: "live",
      message: null,
    },
  };
  const view = await boot(current);
  select("フォーカスする席", "north");
  const setting = request(`/api/studies/${current.study.id}/commands`, "POST");
  expect(body(setting)).toMatchObject({ type: "settings", settings: { focusSide: "north" } });
  const next = await snapshot(updateStudySettings(current.study, { focusSide: "north" }));
  await finish(setting, { ...next, live: current.live });
  expect((field("フォーカスする席") as HTMLSelectElement).value).toBe("north");
  expect(view.textContent).toContain("北にフォーカス");
  expect(view.textContent).toContain("最新局面に追従");
});

for (const eventType of ["snapshot", "analysis"] as const) {
  test(`同じ局面の検討AからBへ切り替える描画前に届く旧Aの${eventType}を除外する`, async () => {
    const original = await initial();
    const next = await snapshot(
      await createStudy({
        id: "next-study",
        title: "切替先の検討B",
        settings: { mode: "analysis" },
      }),
    );
    expect(next.study.currentNodeId).toBe(original.study.currentNodeId);
    expect(next.position.stateHash).toBe(original.position.stateHash);
    const current: StudySnapshot = {
      ...original,
      live: {
        sourceUrl: "https://tetraboard.net/rooms/12345?instanceId=test",
        instanceId: "test",
        roundId: "round-1",
        eventCount: 0,
        latestNodeId: original.study.currentNodeId,
        follow: false,
        status: "finished",
        message: null,
        nextStudyId: next.study.id,
      },
    };
    const view = await boot(current);
    const oldEvents = LocalEvents.instances.at(-1)!;
    const stale: StudyServerEvent =
      eventType === "snapshot"
        ? {
            type: "snapshot",
            snapshot: {
              ...original,
              study: { ...original.study, title: "古い検討Aの通知", revision: 99 },
            },
          }
        : {
            type: "analysis",
            studyId: original.study.id,
            analysis: { ...analysis(original, "completed", 99), nodes: 999999 },
          };
    press(view, "新しい対局を開く");
    const opening = request(`/api/studies/${next.study.id}`);
    let refreshing: PendingRequest | null = null;
    await act(async () => {
      opening.respond(next);
      for (let index = 0; index < 20; index++) await Promise.resolve();
      refreshing = request("/api/studies");
      // HTTP応答が状態更新を予約した後、描画と購読解除より先に旧接続の通知を届けます。
      expect(oldEvents.closed).toBe(false);
      oldEvents.onmessage?.({ data: JSON.stringify(stale) });
    });
    await flush();
    refreshing!.respond(library(next));
    await flush();
    expect(view.textContent?.includes("切替先の検討B")).toBe(true);
    expect(view.textContent?.includes("古い検討Aの通知")).toBe(false);
    expect(view.textContent?.includes("999,999")).toBe(false);
    expect(oldEvents.closed).toBe(true);
  });
}

test("設定の下書き中に別タブで更新されたら上書きを止め、読み直してから保存する", async () => {
  const current = await initial();
  const view = await boot(current);
  press(view, "設定");
  await flush();
  enter(field("検討名") as HTMLInputElement, "このタブの下書き");
  enter(field("1回の検討時間（秒）") as HTMLInputElement, "30");
  const external = await snapshot(
    updateStudySettings(
      current.study,
      { analysisTimeMs: 60000 },
      { title: "別タブで変更した設定" },
    ),
  );
  LocalEvents.instances.at(-1)!.send({ type: "snapshot", snapshot: external });
  await flush();
  expect((field("検討名") as HTMLInputElement).value).toBe("このタブの下書き");
  const save = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === "設定を保存",
  )!;
  expect(save.disabled).toBe(true);
  act(() =>
    field("検討名")
      .closest("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(
    requests.filter((entry) => !answered.has(entry) && entry.url.endsWith("/commands")),
  ).toHaveLength(0);
  press(document.body, "設定を読み直す");
  expect((field("検討名") as HTMLInputElement).value).toBe("別タブで変更した設定");
  expect((field("1回の検討時間（秒）") as HTMLInputElement).value).toBe("60");
  enter(field("1回の検討時間（秒）") as HTMLInputElement, "15");
  act(() =>
    field("検討名")
      .closest("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  const saving = request(`/api/studies/${current.study.id}/commands`, "POST");
  expect(body(saving)).toMatchObject({
    type: "settings",
    expectedRevision: external.study.revision,
    title: "別タブで変更した設定",
    settings: { analysisTimeMs: 15000 },
  });
  await finish(
    saving,
    await snapshot(
      updateStudySettings(external.study, body(saving).settings as Partial<StudySettings>),
    ),
  );
  expect(document.querySelector('[role="dialog"]') === null).toBe(true);
});

test("コメントの外部更新では下書きを残して上書きを止め、自分の保存成功は競合にしない", async () => {
  const base = await initial();
  const current = await snapshot(setStudyComment(base.study, base.study.currentNodeId, "元のメモ"));
  const view = await boot(current);
  enter(field("検討メモ") as HTMLTextAreaElement, "このタブの下書きメモ");
  const external = await snapshot(
    setStudyComment(current.study, current.study.currentNodeId, "別タブで保存したメモ"),
  );
  LocalEvents.instances.at(-1)!.send({ type: "snapshot", snapshot: external });
  await flush();
  expect((field("検討メモ") as HTMLTextAreaElement).value).toBe("このタブの下書きメモ");
  const save = [...view.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === "コメントを保存",
  )!;
  expect(save.disabled).toBe(true);
  act(() =>
    field("検討メモ")
      .closest("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(
    requests.filter((entry) => !answered.has(entry) && entry.url.endsWith("/commands")),
  ).toHaveLength(0);
  press(view, "コメントを読み直す");
  expect((field("検討メモ") as HTMLTextAreaElement).value).toBe("別タブで保存したメモ");
  enter(field("検討メモ") as HTMLTextAreaElement, "読み直した後の追記");
  act(() =>
    field("検討メモ")
      .closest("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  const saving = request(`/api/studies/${current.study.id}/commands`, "POST");
  expect(body(saving)).toMatchObject({
    type: "comment",
    expectedRevision: external.study.revision,
    comment: "読み直した後の追記",
  });
  await finish(
    saving,
    await snapshot(
      setStudyComment(external.study, external.study.currentNodeId, "読み直した後の追記"),
    ),
  );
  expect(view.textContent?.includes("コメントが別の操作で更新されました")).toBe(false);
  expect((field("検討メモ") as HTMLTextAreaElement).value).toBe("読み直した後の追記");
});
