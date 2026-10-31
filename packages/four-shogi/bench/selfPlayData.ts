import {
  analyzePosition,
  resolveAiOptions,
  type AiOptions,
  type AiResult,
  type AiSearchSettings,
} from "../src/ai";
import {
  analysisRuleProfileId,
  restoreAnalysisPosition,
  type AnalysisReplayInput,
  type AnalysisPosition,
} from "../src/analysis";
import { readAnalysisReplay } from "../src/analysisInput";
import { actionEncodingVersion, rotateAction } from "../src/actionEncoding";
import { sides, type Side, type FourShogiState } from "../src/types";
import type { Player } from "./baseline";
import { experimentStarts } from "./searchExperiment";
import type { DataModel } from "./modelRuntime";
import { readStudyCpuSettings, type StudyCpuSettings } from "./studyCpu";

export const selfPlayVersion = "four-shogi-training-record-v1";
export type DataSplit = "train" | "validation" | "calibration" | "test";
export type DataCode = {
  commit: string;
  dirty: boolean;
  sourceHash: string;
  runnerHash: string;
  runtime: { bun: string; platform: string; arch: string };
};
export type DataAgent =
  | { id: string; kind: "study"; settings: StudyCpuSettings }
  | { id: string; kind: "analysis"; settings: AiSearchSettings }
  | { id: string; kind: "cpu"; reference: string };
export type SelfPlayConfig = {
  derivedFrom?: { datasetId: string; contentHash: string };
  teacherSelection?: "trajectory-importance-v1";
  studyTeacher?: StudyCpuSettings;
  model?: DataModel;
  origins: { seed: number; replay: AnalysisReplayInput | null }[];
  restrictions: boolean[];
  seatOffsets: Side[];
  agents: DataAgent[];
  lineups: string[][];
  teacher: AiSearchSettings;
  sampling: { every: number; important: boolean; maxPositions: number };
  maxPlies: number;
};
export type DataStart = {
  origin: number;
  seed: number;
  familyId: string;
  split: DataSplit;
  replay: AnalysisReplayInput;
  stateHash: string;
  restricted: boolean;
};
export type GamePlan = {
  gameId: string;
  start: number;
  lineup: Record<Side, string>;
  seatOffset: Side;
  familyId: string;
  split: DataSplit;
};
export type DataManifest = {
  schemaVersion: 1;
  format: typeof selfPlayVersion;
  actionEncodingVersion: typeof actionEncodingVersion;
  featureVersion: null;
  stateEncodingVersion: "analysis-state-v1";
  code: DataCode;
  config: SelfPlayConfig;
  cpuSources: Record<string, Player["metadata"]>;
  starts: DataStart[];
  datasetId: string;
};
export type TeacherSample = {
  eventOffset: number;
  stateHash: string;
  state: FourShogiState;
  legalActionIds: number[];
  playedActionId: number;
  policyActionId: number | null;
  teacher: AiResult;
};
export type GameArtifact = {
  format: typeof selfPlayVersion;
  datasetId: string;
  plan: GamePlan;
  status: "in_progress" | "finished" | "truncated";
  replay: AnalysisReplayInput;
  openingEventCount: number;
  stateHash: string;
  actors: { eventOffset: number; agentId: string; actionId: number; diagnostics: unknown }[];
  samples: TeacherSample[];
  outcome: null | {
    winner: Side | null;
    target: [number, number, number, number, number];
    result: FourShogiState["result"];
  };
};

export function canonicalData(value: unknown): string {
  const seen = new Set<object>();
  function visit(value: unknown): unknown {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "object" || value === null || seen.has(value))
      throw new TypeError("有限値のJSONが必要です");
    seen.add(value);
    try {
      if (Array.isArray(value)) return value.map(visit);
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null)
        throw new TypeError("通常のJSONオブジェクトが必要です");
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, visit((value as Record<string, unknown>)[key])]),
      );
    } finally {
      seen.delete(value);
    }
  }
  return JSON.stringify(visit(value));
}
export const dataHash = (value: unknown) =>
  new Bun.CryptoHasher("sha256").update(canonicalData(value)).digest("hex");
export const sameData = (a: unknown, b: unknown) => canonicalData(a) === canonicalData(b);
export function dataObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !keys.includes(k))
  )
    throw new TypeError(`不正なデータ項目: ${keys.join(",")}`);
  return value as Record<string, unknown>;
}
export function dataInteger(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    throw new TypeError(`整数の範囲は${min}〜${max}です`);
  return value;
}
export function splitForSeed(seed: number): DataSplit {
  dataInteger(seed, 10000, 99999);
  return seed < 50000
    ? "train"
    : seed < 60000
      ? "validation"
      : seed < 70000
        ? "calibration"
        : "test";
}
function array(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || !value.length || value.length > maximum)
    throw new TypeError("配列の件数が範囲外です");
  return value;
}
function searchSettings(
  input: unknown,
  codeVersion: string,
  fallbackWork: number,
  modelId?: string,
) {
  const options =
    input === undefined
      ? {}
      : dataObject(input, [
          "modelId",
          "modelTimeoutMs",
          "timeBudgetMs",
          "maxWork",
          "maxDepth",
          "width",
          "rootWidth",
          "extensions",
          "candidateCount",
          "algorithm",
          "cacheSize",
          "moveOrdering",
          "evaluationWeights",
          "exploration",
          "rolloutPlies",
          "maxSimulations",
          "seed",
          "dangerWork",
          "dangerPlies",
          "includeAction",
        ]);
  if (options.modelId != null && options.modelId !== modelId)
    throw new TypeError("生成設定のモデルIDと不一致です");
  const resolved = resolveAiOptions({
    maxWork: fallbackWork,
    ...options,
    modelId: modelId ?? null,
    codeVersion,
  } as AiOptions).settings;
  if (resolved.timeBudgetMs !== null)
    throw new TypeError("再開可能な生成は処理量予算を使い、壁時計予算を指定しません");
  if (resolved.includeAction !== null) throw new TypeError("比較する実戦手は局面ごとに設定します");
  return resolved;
}
export function defaultSelfPlayConfig() {
  return {
    origins: [{ seed: 18900 }],
    restrictions: [false, true],
    seatOffsets: ["south", "west", "north", "east"],
    agents: [
      { id: "search", kind: "analysis", options: { maxWork: 256 } },
      { id: "small", kind: "analysis", options: { maxWork: 64 } },
      { id: "lv2", kind: "cpu", reference: "frozen" },
    ],
    lineups: [["search", "lv2", "small", "lv2"]],
    teacher: { maxWork: 2048 },
    sampling: { every: 8, important: true, maxPositions: 32 },
    maxPlies: 256,
  };
}
export function parseSelfPlayConfig(input: unknown, code: DataCode): SelfPlayConfig {
  const raw = dataObject(input, [
    "model",
    "studyTeacher",
    "derivedFrom",
    "teacherSelection",
    "origins",
    "restrictions",
    "seatOffsets",
    "agents",
    "lineups",
    "teacher",
    "sampling",
    "maxPlies",
  ]);
  let model: DataModel | undefined;
  if (raw.model !== undefined) {
    const entry = dataObject(raw.model, ["modelId", "artifactSha256", "codeHash"]);
    if (
      typeof entry.modelId !== "string" ||
      !/^four-shogi-tiny-policy-value-v1:[0-9a-f]{64}$/.test(entry.modelId) ||
      typeof entry.artifactSha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(entry.artifactSha256) ||
      typeof entry.codeHash !== "string" ||
      !/^[0-9a-f]{64}$/.test(entry.codeHash)
    )
      throw new TypeError("生成モデルのID/artifact/code hashが不正です");
    model = entry as DataModel;
  }
  const origins = array(raw.origins, 512).map((entry) => {
    const origin = dataObject(entry, ["seed", "replay"]);
    const seed = dataInteger(origin.seed, 10000, 99999);
    const parsed = origin.replay === undefined ? null : readAnalysisReplay(origin.replay);
    const replay: AnalysisReplayInput | null = parsed
      ? {
          schemaVersion: 1,
          ruleProfileId: analysisRuleProfileId,
          rulesVersion: 1,
          ...parsed,
          initial: {
            ...parsed.initial,
            players: { south: "self-s", west: "self-w", north: "self-n", east: "self-e" },
          },
        }
      : null;
    if (replay && replay.events.length > 4000)
      throw new TypeError("開始棋譜は4000イベント以下です");
    return { seed, replay };
  });
  if (new Set(origins.map((o) => dataHash(o))).size !== origins.length)
    throw new TypeError("開始系列が重複しています");
  const restrictions = array(raw.restrictions, 2).map((value) => {
    if (typeof value !== "boolean") throw new TypeError("ON/OFFを明示してください");
    return value;
  });
  const seatOffsets = array(raw.seatOffsets, 4).map((value) => {
    if (!sides.includes(value as Side)) throw new TypeError("方向が不正です");
    return value as Side;
  });
  if (
    new Set(restrictions).size !== restrictions.length ||
    new Set(seatOffsets).size !== seatOffsets.length
  )
    throw new TypeError("設定/席替えが重複しています");
  const agents: DataAgent[] = array(raw.agents, 16).map((entry) => {
    const agent = dataObject(entry, ["id", "kind", "reference", "options"]);
    if (typeof agent.id !== "string" || !/^[a-zA-Z0-9_-]{1,40}$/.test(agent.id))
      throw new TypeError("相手IDが不正です");
    if (agent.kind === "analysis" && agent.reference === undefined)
      return {
        id: agent.id,
        kind: "analysis",
        settings: searchSettings(agent.options, code.commit, 256, model?.modelId),
      };
    if (agent.kind === "study" && agent.reference === undefined)
      return { id: agent.id, kind: "study", settings: readStudyCpuSettings(agent.options ?? {}) };
    if (
      agent.kind === "cpu" &&
      agent.options === undefined &&
      typeof agent.reference === "string" &&
      /^(frozen|commit:[0-9a-f]{40})$/.test(agent.reference)
    )
      return { id: agent.id, kind: "cpu", reference: agent.reference };
    throw new TypeError("相手は共通探索または固定コミットのCPUです。未対応モデルは使用できません");
  });
  if (new Set(agents.map((a) => a.id)).size !== agents.length)
    throw new TypeError("相手IDが重複しています");
  const lineups = array(raw.lineups, 8).map((entry) => {
    const lineup = array(entry, 4);
    if (lineup.length !== 4 || lineup.some((id) => !agents.some((a) => a.id === id)))
      throw new TypeError("相手群は登録済みID4件です");
    return lineup as string[];
  });
  if (new Set(lineups.map((l) => dataHash(l))).size !== lineups.length)
    throw new TypeError("相手群が重複しています");
  const sampling = dataObject(raw.sampling, ["every", "important", "maxPositions"]);
  if (typeof sampling.important !== "boolean")
    throw new TypeError("重要局面の選別を明示してください");
  const config = {
    ...(raw.teacherSelection === undefined
      ? {}
      : {
          teacherSelection: (() => {
            if (
              raw.teacherSelection !== "trajectory-importance-v1" ||
              !raw.derivedFrom ||
              !raw.studyTeacher ||
              sampling.every !== 0 ||
              sampling.important
            )
              throw new Error("軌跡選別は確定棋譜の派生P0-5教師専用です");
            return "trajectory-importance-v1" as const;
          })(),
        }),
    ...(raw.derivedFrom === undefined
      ? {}
      : {
          derivedFrom: (() => {
            const d = dataObject(raw.derivedFrom, ["datasetId", "contentHash"]);
            if (
              !Object.values(d).every((v) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v)) ||
              Object.keys(d).length !== 2
            )
              throw new Error("由来datasetの識別が不正です");
            return d as { datasetId: string; contentHash: string };
          })(),
        }),
    ...(raw.studyTeacher === undefined
      ? {}
      : { studyTeacher: readStudyCpuSettings(raw.studyTeacher) }),
    ...(model ? { model } : {}),
    origins,
    restrictions,
    seatOffsets,
    agents,
    lineups,
    teacher: searchSettings(raw.teacher, code.commit, 2048, model?.modelId),
    sampling: {
      every: dataInteger(sampling.every, 0, 10000),
      important: sampling.important,
      maxPositions: dataInteger(sampling.maxPositions, 0, 256),
    },
    maxPlies: dataInteger(raw.maxPlies, 1, 2000),
  };
  if (origins.length * restrictions.length * seatOffsets.length * lineups.length > 4096)
    throw new TypeError("一つのdatasetは4096局までです");
  return config;
}

export function replayFamily(replay: AnalysisReplayInput): string {
  const rotations = sides.map((orientation, offset) =>
    canonicalData(
      replay.events.map(({ event }) => ({
        ...event,
        side: sides[(sides.indexOf(event.side) + offset) % 4],
        ...(event.type === "action" ? { action: rotateAction(event.action, orientation) } : {}),
      })),
    ),
  );
  return dataHash({ origin: "full-source-replay-v1", events: rotations.sort()[0] });
}
export function manifestIdentity(manifest: Omit<DataManifest, "datasetId">): string {
  return dataHash(manifest);
}
export async function createDataManifest(
  input: unknown,
  code: DataCode,
  cpuSources: DataManifest["cpuSources"] = {},
): Promise<DataManifest> {
  const config = parseSelfPlayConfig(input, code);
  const starts: DataStart[] = [];
  const families = new Map<string, DataSplit>();
  const states = new Map<string, DataSplit>();
  for (const [origin, source] of config.origins.entries()) {
    const split = splitForSeed(source.seed);
    const familyId = source.replay
      ? replayFamily(source.replay)
      : dataHash({ origin: "seeded-opening-v1", seed: source.seed });
    if (families.has(familyId) && families.get(familyId) !== split)
      throw new Error("同じ元棋譜/回転系列が異なるsplitへ漏れています");
    families.set(familyId, split);
    for (const restricted of config.restrictions) {
      let replay: AnalysisReplayInput;
      if (source.replay) {
        replay = {
          ...source.replay,
          initial: {
            ...source.replay.initial,
            players: { south: "self-s", west: "self-w", north: "self-n", east: "self-e" },
            threePlayerAttackProhibited: restricted,
          },
        };
        await restoreAnalysisPosition({ ...replay, eventOffset: replay.events.length });
      } else replay = (await experimentStarts([restricted], 1, source.seed))[0].replay;
      const position = await restoreAnalysisPosition(replay);
      if (states.has(position.stateHash) && states.get(position.stateHash) !== split)
        throw new Error("同じ開始局面が異なるsplitへ漏れています");
      states.set(position.stateHash, split);
      starts.push({
        origin,
        seed: source.seed,
        familyId,
        split,
        replay,
        stateHash: position.stateHash,
        restricted,
      });
    }
  }
  const parents = new Map(starts.map((s) => [s.familyId, s.familyId]));
  const root = (id: string): string => {
    const next = parents.get(id)!;
    return next === id ? id : root(next);
  };
  const fullSources = new Map<number, Map<string, DataStart>>();
  for (const start of starts) {
    const length = start.replay.events.length;
    if (!length) continue;
    if (!fullSources.has(length)) fullSources.set(length, new Map());
    fullSources.get(length)!.set(replayFamily(start.replay), start);
  }
  for (const start of starts)
    for (const [length, sources] of fullSources) {
      if (length > start.replay.events.length) continue;
      const prior = sources.get(
        replayFamily({ ...start.replay, events: start.replay.events.slice(0, length) }),
      );
      if (!prior) continue;
      if (prior.split !== start.split)
        throw new Error("元棋譜の全体/途中ファイルまたは回転系列がsplitを横断しています");
      const a = root(prior.familyId),
        b = root(start.familyId);
      parents.set(a < b ? b : a, a < b ? a : b);
    }
  for (const start of starts) start.familyId = root(start.familyId);
  const manifest: Omit<DataManifest, "datasetId"> = {
    schemaVersion: 1,
    format: selfPlayVersion,
    actionEncodingVersion,
    featureVersion: null,
    stateEncodingVersion: "analysis-state-v1",
    code,
    config,
    cpuSources,
    starts,
  };
  return { ...manifest, datasetId: manifestIdentity(manifest) };
}
export function gamePlans(manifest: DataManifest): GamePlan[] {
  const plans = manifest.starts.flatMap((start, index) =>
    manifest.config.lineups.flatMap((ids) =>
      manifest.config.seatOffsets.map((seatOffset) => {
        const lineup = Object.fromEntries(
          sides.map((side, sideIndex) => [
            side,
            ids[(sideIndex - sides.indexOf(seatOffset) + 4) % 4],
          ]),
        ) as Record<Side, string>;
        return {
          gameId: dataHash({ datasetId: manifest.datasetId, stateHash: start.stateHash, lineup }),
          start: index,
          seatOffset,
          familyId: start.familyId,
          split: start.split,
          lineup,
        };
      }),
    ),
  );
  return [...new Map(plans.map((plan) => [plan.gameId, plan])).values()];
}
export function outcomeFor(position: AnalysisPosition): GameArtifact["outcome"] {
  if (position.state.status !== "finished") return null;
  const result = position.state.result;
  if (result.mode !== "singles") throw new TypeError("シングルス結果が必要です");
  const first = result.standings.filter((s) => s.rank === 1);
  const winner = first.length === 1 ? first[0].side : null;
  return {
    winner,
    target: [...sides.map((side) => Number(side === winner)), Number(winner === null)] as [
      number,
      number,
      number,
      number,
      number,
    ],
    result,
  };
}
export function positionFamilyKey(state: FourShogiState): string {
  const rotated = sides.map((orientation, offset) => {
    const owner = (side: Side) => sides[(sides.indexOf(side) + offset) % 4];
    const pieces = state.board.flatMap((row, y) =>
      row.flatMap((piece, x) =>
        piece
          ? [
              {
                owner: owner(piece.side),
                kind: piece.kind,
                promoted: piece.promoted,
                square: rotateAction(
                  { type: "dropPiece", pieceKind: "pawn", to: { x, y } },
                  orientation,
                ).to,
              },
            ]
          : [],
      ),
    );
    return canonicalData({
      pieces: pieces.sort((a, b) => {
        const x = canonicalData(a),
          y = canonicalData(b);
        return x < y ? -1 : x > y ? 1 : 0;
      }),
      hands: Object.fromEntries(sides.map((side) => [owner(side), state.hands[side]])),
      turn: state.turn === null ? null : owner(state.turn),
      eliminated: state.eliminations.map((e) => owner(e.side)).sort(),
    });
  });
  // 盤面等だけの一致も保守的に漏れとして扱い、履歴の違いを無視して学習局面を合流しません。
  return dataHash(rotated.sort()[0]);
}
export type AnalysisFunction = typeof analyzePosition;
