import { sides, type Side } from "@tetraboard/four-shogi";
import {
  advanceAnalysisPosition,
  analysisRuleProfileId,
  createAnalysisSetupPosition,
  restoreAnalysisPosition,
  validateAnalysisReplay,
  validateAnalysisReplayEvent,
  validateAnalysisSetup,
  type AnalysisPosition,
  type AnalysisSetupInput,
} from "@tetraboard/four-shogi/analysis";
import {
  defaultStudySettings,
  type StudyDocument,
  type StudyNode,
  type StudyOrigin,
  type StudyPositionInput,
  type StudySettings,
  type StudySeat,
  type StudyRecordedAnalysis,
} from "../shared/model";

export class StudyInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StudyInputError";
  }
}
const trustedDocuments = new WeakSet<StudyDocument>();
function trusted(study: StudyDocument): StudyDocument {
  freeze(study);
  trustedDocuments.add(study);
  return study;
}
function fail(message: string): never {
  throw new StudyInputError(message);
}
function object(value: unknown, keys: readonly string[], required = keys): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("JSONオブジェクトが必要です");
  if (
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.keys(value).some((key) => !keys.includes(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  )
    fail(`入力項目を確認してください: ${keys.join(", ")}`);
  return value as Record<string, unknown>;
}
export function validateStudyId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(value))
    fail("検討または局面のIDが不正です");
  return value;
}
function title(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200)
    fail("題名は1〜200文字です");
  return value.trim();
}
function side(value: unknown): Side {
  if (!sides.some((entry) => entry === value)) fail("CPUの担当方向が不正です");
  return value as Side;
}
function timestamp(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) fail("保存時刻が不正です");
  return new Date(value).toISOString();
}
export function readStudySettings(value: unknown, legacyCpuSide?: Side): StudySettings {
  const item = object(
    value,
    [
      "mode",
      "thinkTimeMs",
      "threads",
      "memoryMb",
      "analysisTimeMs",
      "focusSide",
      "seats",
      "searchStrategy",
    ],
    ["mode", "thinkTimeMs", "threads", "memoryMb"],
  );
  if (item.mode !== "auto" && item.mode !== "analysis") fail("CPUの動作モードが不正です");
  const focusSide = item.focusSide ?? null;
  const searchStrategy = item.searchStrategy ?? "adaptive";
  if (searchStrategy !== "adaptive" && searchStrategy !== "dual") fail("探索方式が不正です");
  if (focusSide !== null && !sides.some((entry) => entry === focusSide))
    fail("フォーカスする席が不正です");
  for (const [key, minimum, maximum] of [
    ["thinkTimeMs", 100, 3_600_000],
    ["threads", 1, 32],
    ["memoryMb", 256, 65536],
  ] as const) {
    const value = item[key];
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < minimum ||
      value > maximum
    )
      fail(`${key}の設定が範囲外です`);
  }
  const analysisTimeMs = item.analysisTimeMs === undefined ? 5000 : item.analysisTimeMs;
  if (
    analysisTimeMs !== null &&
    (typeof analysisTimeMs !== "number" ||
      !Number.isSafeInteger(analysisTimeMs) ||
      analysisTimeMs < 100 ||
      analysisTimeMs > 3_600_000)
  )
    fail("検討時間は0.1〜3600秒または停止するまでです");
  const rawSeats = item.seats === undefined ? null : object(item.seats, sides);
  const seats = Object.fromEntries(
    sides.map((current) => {
      const raw = rawSeats
        ? object(rawSeats[current], ["controller", "thinkTimeMs"])
        : {
            controller: legacyCpuSide
              ? current === legacyCpuSide
                ? "cpu"
                : "human"
              : defaultStudySettings.seats[current].controller,
            thinkTimeMs: item.thinkTimeMs,
          };
      if (
        (raw.controller !== "human" && raw.controller !== "cpu") ||
        typeof raw.thinkTimeMs !== "number" ||
        !Number.isSafeInteger(raw.thinkTimeMs) ||
        raw.thinkTimeMs < 100 ||
        raw.thinkTimeMs > 3_600_000
      )
        fail("各席の担当とCPU思考時間を確認してください");
      return [current, { controller: raw.controller, thinkTimeMs: raw.thinkTimeMs }];
    }),
  ) as Record<Side, StudySeat>;
  return {
    searchStrategy,
    mode: item.mode,
    thinkTimeMs: item.thinkTimeMs as number,
    threads: item.threads as number,
    memoryMb: item.memoryMb as number,
    analysisTimeMs,
    focusSide: focusSide as Side | null,
    seats,
  };
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function readOrigin(value: unknown): StudyOrigin {
  const kind = value && typeof value === "object" && "kind" in value ? value.kind : null;
  if (kind === "replay") {
    const item = object(value, ["kind", "replay", "sourceUrl"], ["kind", "replay"]);
    if (
      item.sourceUrl !== undefined &&
      (typeof item.sourceUrl !== "string" || item.sourceUrl.length > 2048)
    )
      fail("元の棋譜URLが不正です");
    const replay = validateAnalysisReplay(item.replay);
    return {
      kind,
      replay: { ...replay, events: replay.events.slice(0, replay.eventOffset) },
      ...(item.sourceUrl === undefined ? {} : { sourceUrl: item.sourceUrl as string }),
    };
  }
  if (kind === "setup") {
    const item = object(value, ["kind", "setup", "sourceReference"], ["kind", "setup"]);
    const reference =
      item.sourceReference === undefined
        ? undefined
        : object(item.sourceReference, ["studyId", "nodeId"]);
    return {
      kind,
      setup: validateAnalysisSetup(item.setup),
      ...(reference
        ? {
            sourceReference: {
              studyId: validateStudyId(reference.studyId),
              nodeId: validateStudyId(reference.nodeId),
            },
          }
        : {}),
    };
  }
  return fail("未対応の検討開始形式です");
}
export async function restoreStudyPosition(input: StudyPositionInput): Promise<AnalysisPosition> {
  const raw = object(input, ["origin", "events"]);
  const origin = readOrigin(raw.origin);
  if (!Array.isArray(raw.events) || raw.events.length > 20000) fail("分岐のイベント数が不正です");
  let position =
    origin.kind === "replay"
      ? await restoreAnalysisPosition(origin.replay)
      : await createAnalysisSetupPosition(origin.setup);
  for (const event of raw.events) position = await advanceAnalysisPosition(position, event);
  return position;
}

export type StudyCreateOptions = {
  id?: string;
  title?: string;
  cpuSide?: Side;
  settings?: Partial<StudySettings>;
  origin?: StudyOrigin;
  threePlayerAttackProhibited?: boolean;
  nowMs?: number;
};
export async function createStudy(options: StudyCreateOptions = {}): Promise<StudyDocument> {
  const origin = readOrigin(
    options.origin ?? {
      kind: "replay",
      replay: {
        schemaVersion: 1,
        ruleProfileId: analysisRuleProfileId,
        rulesVersion: 1,
        initial: {
          mode: "singles",
          players: {
            south: "study-south",
            west: "study-west",
            north: "study-north",
            east: "study-east",
          },
          threePlayerAttackProhibited: options.threePlayerAttackProhibited ?? true,
        },
        events: [],
      },
    },
  );
  const position = await restoreStudyPosition({ origin, events: [] });
  const createdAt = new Date(options.nowMs ?? Date.now()).toISOString();
  const study = trusted({
    schemaVersion: 1,
    id: validateStudyId(options.id ?? crypto.randomUUID()),
    title: title(options.title ?? "新しい検討"),
    createdAt,
    updatedAt: createdAt,
    revision: 0,
    cpuSide: side(options.cpuSide ?? "south"),
    settings: readStudySettings(
      {
        ...defaultStudySettings,
        ...(options.cpuSide && !options.settings?.seats ? { seats: undefined } : {}),
        ...options.settings,
      },
      options.cpuSide,
    ),
    playEnabled: false,
    origin,
    nodes: [{ id: "root", parentId: null, event: null }],
    currentNodeId: "root",
  });
  restoredDocuments.set(study, Promise.resolve(new Map([["root", position]])));
  return study;
}
export async function createSetupStudy(
  setup: AnalysisSetupInput,
  options: Omit<StudyCreateOptions, "origin"> & {
    sourceReference?: { studyId: string; nodeId: string };
  } = {},
): Promise<StudyDocument> {
  return createStudy({
    ...options,
    origin: {
      kind: "setup",
      setup,
      ...(options.sourceReference ? { sourceReference: options.sourceReference } : {}),
    },
  });
}

export function studyPath(
  study: StudyDocument,
  nodeId = study.currentNodeId,
): readonly StudyNode[] {
  const nodes = new Map(study.nodes.map((node) => [node.id, node]));
  const path: StudyNode[] = [];
  let current: string | null = nodeId;
  const seen = new Set<string>();
  while (current !== null) {
    const node = nodes.get(current);
    if (!node || seen.has(current)) fail("分岐が存在しないか循環しています");
    seen.add(current);
    path.unshift(node);
    current = node.parentId;
  }
  return path;
}
export function studyPositionInput(
  study: StudyDocument,
  nodeId = study.currentNodeId,
): StudyPositionInput {
  return {
    origin: study.origin,
    events: studyPath(study, nodeId).flatMap((node) => (node.event ? [node.event] : [])),
  };
}

const restoredDocuments = new WeakMap<
  StudyDocument,
  Promise<ReadonlyMap<string, AnalysisPosition>>
>();
export function resolveStudyPositions(
  study: StudyDocument,
): Promise<ReadonlyMap<string, AnalysisPosition>> {
  const existing = restoredDocuments.get(study);
  if (existing) return existing;
  const restoration = (async () => {
    const positions = new Map<string, AnalysisPosition>();
    for (const node of study.nodes) {
      if (node.parentId === null)
        positions.set(node.id, await restoreStudyPosition({ origin: study.origin, events: [] }));
      else {
        const parent = positions.get(node.parentId);
        if (!parent || !node.event) fail("分岐の親局面が見つかりません");
        positions.set(node.id, await advanceAnalysisPosition(parent, node.event));
      }
    }
    return positions;
  })();
  restoredDocuments.set(study, restoration);
  return restoration;
}
function updated(
  study: StudyDocument,
  changes: Partial<StudyDocument>,
  nowMs = Date.now(),
): StudyDocument {
  const next = trusted({
    ...study,
    ...changes,
    revision: study.revision + 1,
    updatedAt: new Date(nowMs).toISOString(),
  });
  const positions = restoredDocuments.get(study);
  if (positions && next.nodes === study.nodes && next.origin === study.origin)
    restoredDocuments.set(next, positions);
  return next;
}
export async function appendStudyEvent(
  study: StudyDocument,
  input: unknown,
  nowMs = Date.now(),
): Promise<StudyDocument> {
  const event = validateAnalysisReplayEvent(input);
  const positions = await resolveStudyPositions(study);
  const parent = positions.get(study.currentNodeId);
  if (!parent) fail("選択中の局面がありません");
  const advanced = await advanceAnalysisPosition(parent, event);
  const existing = study.nodes.find(
    (node) =>
      node.parentId === study.currentNodeId && JSON.stringify(node.event) === JSON.stringify(event),
  );
  const node: StudyNode = existing ?? {
    id: crypto.randomUUID(),
    parentId: study.currentNodeId,
    event,
  };
  const next = updated(
    study,
    { nodes: existing ? study.nodes : [...study.nodes, node], currentNodeId: node.id },
    nowMs,
  );
  if (!existing)
    restoredDocuments.set(next, Promise.resolve(new Map([...positions, [node.id, advanced]])));
  return next;
}
export function selectStudyNode(
  study: StudyDocument,
  nodeId: string,
  nowMs = Date.now(),
): StudyDocument {
  if (!study.nodes.some((node) => node.id === nodeId)) fail("選択した局面がありません");
  return updated(study, { currentNodeId: nodeId, playEnabled: false }, nowMs);
}
export function updateStudySettings(
  study: StudyDocument,
  settings: Partial<StudySettings>,
  options: { title?: string; cpuSide?: Side; nowMs?: number } = {},
): StudyDocument {
  return updated(
    study,
    {
      settings: readStudySettings({ ...study.settings, ...settings }),
      title: options.title === undefined ? study.title : title(options.title),
      cpuSide: options.cpuSide === undefined ? study.cpuSide : side(options.cpuSide),
      playEnabled: false,
    },
    options.nowMs,
  );
}
export function setStudyPlayEnabled(
  study: StudyDocument,
  enabled: boolean,
  nowMs = Date.now(),
): StudyDocument {
  if (typeof enabled !== "boolean") fail("対局再開の指定が不正です");
  return updated(study, { playEnabled: enabled }, nowMs);
}

export function setStudyComment(
  study: StudyDocument,
  nodeId: string,
  comment: string,
): StudyDocument {
  if (
    typeof comment !== "string" ||
    comment.length > 10000 ||
    !study.nodes.some((node) => node.id === nodeId)
  )
    fail("コメントは既存の局面に10000文字以内で入力してください");
  return updated(study, {
    nodes: study.nodes.map((node) => (node.id === nodeId ? { ...node, comment } : node)),
  });
}

export function recordStudyAnalysis(
  study: StudyDocument,
  nodeId: string,
  record: StudyRecordedAnalysis,
): StudyDocument {
  if (!study.nodes.some((node) => node.id === nodeId)) fail("解析を保存する局面がありません");
  return updated(study, { analysisRecords: { ...study.analysisRecords, [nodeId]: record } });
}

/** 保存形式の構造だけでなく、全分岐を正本のルールで再生して検証します。 */
export async function parseStudyDocument(input: unknown): Promise<StudyDocument> {
  if (input && typeof input === "object" && trustedDocuments.has(input as StudyDocument))
    return input as StudyDocument;
  const required = [
    "schemaVersion",
    "id",
    "title",
    "createdAt",
    "updatedAt",
    "revision",
    "cpuSide",
    "settings",
    "playEnabled",
    "origin",
    "nodes",
    "currentNodeId",
  ];
  const item = object(input, [...required, "analysisRecords"], required);
  if (item.schemaVersion !== 1) fail("未対応の検討ファイル版です");
  if (
    typeof item.revision !== "number" ||
    !Number.isSafeInteger(item.revision) ||
    item.revision < 0
  )
    fail("更新番号が不正です");
  if (typeof item.playEnabled !== "boolean") fail("対局実行状態が不正です");
  if (!Array.isArray(item.nodes) || item.nodes.length < 1 || item.nodes.length > 20000)
    fail("分岐数が不正です");
  const seen = new Set<string>();
  const nodes = item.nodes.map((value, index): StudyNode => {
    const raw = object(value, ["id", "parentId", "event", "comment"], ["id", "parentId", "event"]);
    const id = validateStudyId(raw.id);
    if (seen.has(id)) fail("局面IDが重複しています");
    if (
      index === 0
        ? raw.parentId !== null || raw.event !== null
        : typeof raw.parentId !== "string" || !seen.has(raw.parentId) || raw.event === null
    )
      fail("分岐の親子関係が不正です");
    seen.add(id);
    if (
      raw.comment !== undefined &&
      (typeof raw.comment !== "string" || raw.comment.length > 10000)
    )
      fail("コメントが不正です");
    return {
      id,
      parentId: raw.parentId === null ? null : validateStudyId(raw.parentId),
      event: raw.event === null ? null : validateAnalysisReplayEvent(raw.event),
      ...(raw.comment === undefined ? {} : { comment: raw.comment as string }),
    };
  });
  const currentNodeId = validateStudyId(item.currentNodeId);
  if (!seen.has(currentNodeId)) fail("選択中の局面がありません");
  const study: StudyDocument = freeze({
    schemaVersion: 1,
    id: validateStudyId(item.id),
    title: title(item.title),
    createdAt: timestamp(item.createdAt),
    updatedAt: timestamp(item.updatedAt),
    revision: item.revision,
    cpuSide: side(item.cpuSide),
    settings: readStudySettings(item.settings, side(item.cpuSide)),
    playEnabled: item.playEnabled,
    origin: readOrigin(item.origin),
    nodes,
    currentNodeId,
  });
  const positions = await resolveStudyPositions(study);
  if (item.analysisRecords !== undefined) {
    const { parseRecordedAnalyses } = await import("./recordedAnalysis");
    const analysisRecords = await parseRecordedAnalyses(item.analysisRecords, positions);
    const result = trusted({ ...study, analysisRecords });
    restoredDocuments.set(result, Promise.resolve(positions));
    return result;
  }
  return trusted(study);
}

export async function importReplayStudy(
  input: unknown,
  options: Omit<StudyCreateOptions, "origin"> & { sourceUrl?: string } = {},
): Promise<StudyDocument> {
  const replay = validateAnalysisReplay(input);
  let study = await createStudy({
    ...options,
    origin: {
      kind: "replay",
      replay: { ...replay, events: [], eventOffset: 0 },
      ...(options.sourceUrl ? { sourceUrl: options.sourceUrl } : {}),
    },
  });
  const nodes: StudyNode[] = [...study.nodes];
  let position = await restoreStudyPosition({ origin: study.origin, events: [] });
  const positions = new Map([[nodes[0].id, position]]);
  for (const { event } of replay.events) {
    position = await advanceAnalysisPosition(position, event);
    nodes.push({ id: `event-${nodes.length}`, parentId: nodes[nodes.length - 1].id, event });
    positions.set(nodes[nodes.length - 1].id, position);
  }
  study = trusted({ ...study, nodes, currentNodeId: nodes[replay.eventOffset].id });
  restoredDocuments.set(study, Promise.resolve(positions));
  return study;
}

export async function cloneImportedStudy(
  input: unknown,
  nowMs = Date.now(),
): Promise<StudyDocument> {
  const study = await parseStudyDocument(input);
  const now = new Date(nowMs).toISOString();
  const next = trusted({
    ...study,
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    revision: 0,
    playEnabled: false,
  });
  const positions = restoredDocuments.get(study);
  if (positions) restoredDocuments.set(next, positions);
  return next;
}
