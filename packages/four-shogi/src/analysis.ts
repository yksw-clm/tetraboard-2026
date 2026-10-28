import { createInitialState, getLegalActions } from "./index";
import type { FourShogiState, FourShogiAction } from "./types";
import { applyReplayEvent } from "./replay";
import { readAnalysisSetup } from "./analysisSetup";
import {
  analysisRuleProfileId,
  AnalysisInputError,
  readAnalysisReplay,
  readReplayEvent,
  type AnalysisReplayInput,
} from "./analysisInput";

export { analysisRuleProfileId, AnalysisInputError } from "./analysisInput";
export type { AnalysisReplayInput, AnalysisInputErrorCode } from "./analysisInput";
export type { FourShogiReplayEvent } from "./replay";
export type { AnalysisSetupInput } from "./analysisSetup";

/** 自由編集を、履歴をリセットした検証済みの新しい起点へ変換します。 */
export async function createAnalysisSetupPosition(input: unknown): Promise<AnalysisPosition> {
  return makePosition(readAnalysisSetup(input).state, 0);
}

export function validateAnalysisSetup(input: unknown) {
  return readAnalysisSetup(input).setup;
}

export function validateAnalysisReplay(
  input: unknown,
): AnalysisReplayInput & { eventOffset: number } {
  return {
    schemaVersion: 1 as const,
    ruleProfileId: analysisRuleProfileId,
    rulesVersion: 1 as const,
    ...readAnalysisReplay(input),
  };
}

export { readReplayEvent as validateAnalysisReplayEvent } from "./analysisInput";
export type AnalysisPosition = Readonly<{
  analysisStateVersion: 1;
  ruleProfileId: typeof analysisRuleProfileId;
  rulesVersion: 1;
  eventOffset: number;
  stateHash: string;
  state: FourShogiState;
}>;
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
export type AnalysisCacheIdentity = Readonly<{
  codeVersion: string;
  analysisVersion: string;
  modelId: string | null;
  parameters: Readonly<Record<string, JsonValue>>;
}>;
const positions = new WeakSet<AnalysisPosition>();

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function canonicalJson(value: unknown, parents = new Set<object>()): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== "object" || value === null || parents.has(value) || parents.size >= 64)
    throw new AnalysisInputError(
      "invalid_input",
      "識別子の入力は有限値と循環のないJSONに限定します",
    );
  parents.add(value);
  try {
    if (Array.isArray(value))
      return `[${Array.from(value, (child) => canonicalJson(child, parents)).join(",")}]`;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new AnalysisInputError("invalid_input", "識別子には通常のJSONオブジェクトが必要です");
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key], parents)}`)
      .join(",")}}`;
  } finally {
    parents.delete(value);
  }
}
async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function requirePosition(position: AnalysisPosition) {
  if (position === null || typeof position !== "object" || !positions.has(position))
    throw new AnalysisInputError(
      "untrusted_position",
      "解析APIで復元した局面が必要です。表示frameやJSON状態を代用できません",
    );
}
/** 正本の完全状態の照合用です。ハッシュだけでは解析局面の信頼性を付与しません。 */
export async function getAnalysisStateHash(state: FourShogiState): Promise<string> {
  const { players: _players, ...ruleState } = state;
  return sha256({ analysisStateVersion: 1, ruleProfileId: analysisRuleProfileId, ruleState });
}
async function makePosition(state: FourShogiState, eventOffset: number): Promise<AnalysisPosition> {
  freeze(state);
  // 参加者の紐付けは要求文脈で管理し、ルール状態の識別へ混ぜません。
  const stateHash = await getAnalysisStateHash(state);
  const position = freeze<AnalysisPosition>({
    analysisStateVersion: 1 as const,
    ruleProfileId: analysisRuleProfileId,
    rulesVersion: 1 as const,
    eventOffset,
    stateHash,
    state,
  });
  positions.add(position);
  return position;
}

/** eventOffsetは着手数ではなく、適用する連番イベント数を表します。 */
export async function restoreAnalysisPosition(input: unknown): Promise<AnalysisPosition> {
  const replay = readAnalysisReplay(input);
  let state = createInitialState(replay.initial);
  for (let index = 0; index < replay.eventOffset; index++) {
    const result = applyReplayEvent(state, replay.events[index].event);
    if (!result.ok)
      throw new AnalysisInputError(
        "event_rejected",
        `棋譜イベントを受理できません: ${result.reason}`,
        index,
      );
    state = result.state;
  }
  return makePosition(state, replay.eventOffset);
}

export function getAnalysisLegalActions(position: AnalysisPosition): readonly FourShogiAction[] {
  requirePosition(position);
  return freeze(getLegalActions(position.state));
}

/** 棋譜と元局面を変更せず、仮の着手・脱落・提案から新しい解析局面を返します。 */
export async function advanceAnalysisPosition(
  position: AnalysisPosition,
  event: unknown,
): Promise<AnalysisPosition> {
  requirePosition(position);
  const result = applyReplayEvent(position.state, readReplayEvent(event));
  if (!result.ok)
    throw new AnalysisInputError(
      "event_rejected",
      `解析イベントを受理できません: ${result.reason}`,
      position.eventOffset,
    );
  return makePosition(result.state, position.eventOffset + 1);
}

/** parametersには予算・相手仮定・seed等を解決済みの値で渡します。 */
export async function createAnalysisCacheKey(
  position: AnalysisPosition,
  identity: AnalysisCacheIdentity,
): Promise<string> {
  requirePosition(position);
  if (
    !identity ||
    typeof identity !== "object" ||
    Array.isArray(identity) ||
    [identity.codeVersion, identity.analysisVersion].some(
      (version) => typeof version !== "string" || version.trim().length === 0,
    ) ||
    (identity.modelId !== null &&
      (typeof identity.modelId !== "string" || identity.modelId.trim().length === 0)) ||
    identity.parameters === null ||
    typeof identity.parameters !== "object" ||
    Array.isArray(identity.parameters)
  )
    throw new AnalysisInputError(
      "invalid_input",
      "コード・解析・モデル版と解析条件の指定が必要です",
    );
  return sha256({
    analysisCacheVersion: 1,
    stateHash: position.stateHash,
    identity: {
      codeVersion: identity.codeVersion,
      analysisVersion: identity.analysisVersion,
      modelId: identity.modelId,
      parameters: identity.parameters,
    },
  });
}
