import { handPieceKinds, sides, type InitialStateOptions, type Position, type Side } from "./types";
import type { FourShogiReplayEvent } from "./replay";

export const analysisRuleProfileId = "tetraboard-four-shogi-singles-v1";
export type AnalysisInputErrorCode =
  | "invalid_input"
  | "unsupported_version"
  | "unsupported_profile"
  | "unsupported_mode"
  | "non_contiguous_events"
  | "invalid_offset"
  | "event_rejected"
  | "untrusted_position";

export class AnalysisInputError extends Error {
  readonly code: AnalysisInputErrorCode;
  readonly eventIndex?: number;
  constructor(code: AnalysisInputErrorCode, message: string, eventIndex?: number) {
    super(message);
    this.name = "AnalysisInputError";
    this.code = code;
    this.eventIndex = eventIndex;
  }
}
export type AnalysisReplayInput = Readonly<{
  schemaVersion: 1;
  ruleProfileId: typeof analysisRuleProfileId;
  rulesVersion: 1;
  initial: InitialStateOptions &
    Readonly<{ mode: "singles"; threePlayerAttackProhibited: boolean }>;
  events: readonly Readonly<{ index: number; event: FourShogiReplayEvent }>[];
  eventOffset?: number;
}>;

function invalid(message: string): never {
  throw new AnalysisInputError("invalid_input", message);
}
function record(value: unknown, keys: readonly string[], required = keys): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    invalid("JSONオブジェクトが必要です");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    invalid("通常のJSONオブジェクトが必要です");
  if (
    Object.keys(value).some((key) => !keys.includes(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  )
    invalid(`必要な入力項目と一致しません: ${keys.join(", ")}`);
  return value as Record<string, unknown>;
}
function side(value: unknown): Side {
  if (!sides.some((entry) => entry === value)) invalid("未対応の担当方向です");
  return value as Side;
}
function position(value: unknown): Position {
  const result = record(value, ["x", "y"]);
  if (
    ![result.x, result.y].every(
      (coordinate) =>
        typeof coordinate === "number" &&
        Number.isSafeInteger(coordinate) &&
        coordinate >= 0 &&
        coordinate <= 8,
    )
  )
    invalid("座標は0〜8の整数です");
  return { x: result.x as number, y: result.y as number };
}

export function readReplayEvent(value: unknown): FourShogiReplayEvent {
  const type = value !== null && typeof value === "object" && "type" in value ? value.type : null;
  if (type === "action") {
    const event = record(value, ["type", "side", "action"]);
    const raw = event.action;
    const actionType = raw !== null && typeof raw === "object" && "type" in raw ? raw.type : null;
    if (actionType === "movePiece") {
      const action = record(raw, ["type", "from", "to", "promote"]);
      if (typeof action.promote !== "boolean") invalid("成り指定はbooleanです");
      return {
        type,
        side: side(event.side),
        action: {
          type: actionType,
          from: position(action.from),
          to: position(action.to),
          promote: action.promote,
        },
      };
    }
    if (actionType === "dropPiece") {
      const action = record(raw, ["type", "pieceKind", "to"]);
      if (!handPieceKinds.some((kind) => kind === action.pieceKind)) invalid("未対応の持ち駒です");
      return {
        type,
        side: side(event.side),
        action: {
          type: actionType,
          pieceKind: action.pieceKind as (typeof handPieceKinds)[number],
          to: position(action.to),
        },
      };
    }
    invalid("未対応の着手形式です");
  }
  if (type === "eliminate") {
    const event = record(value, ["type", "side", "reason"]);
    const reasons = ["resigned", "left", "timeout", "disconnected"] as const;
    if (!reasons.some((reason) => reason === event.reason)) invalid("外部脱落理由が不正です");
    return { type, side: side(event.side), reason: event.reason as (typeof reasons)[number] };
  }
  if (type === "drawProposal") {
    const event = record(value, ["type", "side", "proposed"]);
    if (typeof event.proposed !== "boolean") invalid("引分提案はbooleanです");
    return { type, side: side(event.side), proposed: event.proposed };
  }
  invalid("未対応の棋譜イベントです");
}

export function readAnalysisReplay(value: unknown) {
  const input = record(
    value,
    ["schemaVersion", "ruleProfileId", "rulesVersion", "initial", "events", "eventOffset"],
    ["schemaVersion", "ruleProfileId", "rulesVersion", "initial", "events"],
  );
  if (input.schemaVersion !== 1 || input.rulesVersion !== 1)
    throw new AnalysisInputError(
      "unsupported_version",
      "解析入力・再生ルールは版1のみ対応しています",
    );
  if (input.ruleProfileId !== analysisRuleProfileId)
    throw new AnalysisInputError("unsupported_profile", "未対応のルールプロフィールです");
  const initial = record(input.initial, ["mode", "players", "threePlayerAttackProhibited"]);
  if (initial.mode !== "singles")
    throw new AnalysisInputError("unsupported_mode", "解析APIはシングルス専用です");
  if (typeof initial.threePlayerAttackProhibited !== "boolean")
    invalid("三人攻撃禁止ON/OFFは明示的なbooleanが必要です");
  const rawPlayers = record(initial.players, sides);
  const players = {} as Record<Side, string>;
  for (const direction of sides) {
    const id = rawPlayers[direction];
    if (typeof id !== "string" || id.length === 0) invalid("四方向の参加者IDが必要です");
    players[direction] = id;
  }
  if (new Set(Object.values(players)).size !== 4) invalid("参加者IDは重複できません");
  if (!Array.isArray(input.events)) invalid("イベント配列が必要です");
  const events = Array.from(input.events, (raw, index) => {
    const entry = record(raw, ["index", "event"]);
    if (entry.index !== index)
      throw new AnalysisInputError(
        "non_contiguous_events",
        "イベントindexは0から連続する必要があります",
        index,
      );
    try {
      return { index, event: readReplayEvent(entry.event) };
    } catch (error) {
      if (error instanceof AnalysisInputError)
        throw new AnalysisInputError(error.code, error.message, index);
      throw error;
    }
  });
  const eventOffset = Object.hasOwn(input, "eventOffset") ? input.eventOffset : events.length;
  if (
    typeof eventOffset !== "number" ||
    !Number.isSafeInteger(eventOffset) ||
    eventOffset < 0 ||
    eventOffset > events.length
  )
    throw new AnalysisInputError("invalid_offset", "eventOffsetは0〜提供イベント数の整数です");
  return {
    initial: {
      mode: "singles" as const,
      players,
      threePlayerAttackProhibited: initial.threePlayerAttackProhibited,
    },
    events,
    eventOffset,
  };
}
