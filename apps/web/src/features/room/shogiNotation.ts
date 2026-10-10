import type { FourShogiAction, Piece, Position, Side } from "./shogiUiTypes";
import { shogiDisplayPosition, shogiSamePosition } from "./shogiBoardPresentation";

export type ReplayLabel = { label: string; accessibleLabel?: string };
export type NotationMove = {
  action: Extract<FourShogiAction, { type: "movePiece" }>;
  piece: Pick<Piece, "kind" | "promoted">;
};
const pieceNames = {
  king: "王",
  rook: "飛",
  bishop: "角",
  gold: "金",
  silver: "銀",
  knight: "桂",
  lance: "香",
  pawn: "歩",
} as const;
const promotedNames = {
  rook: "龍",
  bishop: "馬",
  silver: "成銀",
  knight: "成桂",
  lance: "成香",
  pawn: "と",
} as const;

export function shogiNotationSquare(position: Position): string {
  return `${9 - position.x}${"一二三四五六七八九"[position.y]}`;
}

export function shogiNotationPiece(piece: Pick<Piece, "kind" | "promoted">): string {
  return piece.promoted && piece.kind in promotedNames
    ? promotedNames[piece.kind as keyof typeof promotedNames]
    : pieceNames[piece.kind];
}

export function shogiReplayLabel(
  mark: string,
  name: string,
  text: string,
  moveNumber?: number,
): ReplayLabel {
  const prefix = moveNumber === undefined ? "" : `${moveNumber}: `;
  const separator = moveNumber === undefined ? " " : "";
  return {
    label: `${prefix}${mark}${separator}${text}`,
    ...(mark !== name ? { accessibleLabel: `${prefix}${name}${separator}${text}` } : {}),
  };
}

/** 候補は着手前の合法手。成りの二択を同じ移動元として扱う。 */
export function shogiMoveNotation({
  action,
  piece,
  legalMoves,
  previousDestination,
  side,
  allowDragonStraight = false,
}: {
  action: FourShogiAction;
  piece: Pick<Piece, "kind" | "promoted">;
  legalMoves: readonly NotationMove[];
  previousDestination: Position | null;
  side: Side;
  allowDragonStraight?: boolean;
}): string {
  const destination =
    previousDestination && shogiSamePosition(previousDestination, action.to)
      ? "同"
      : shogiNotationSquare(action.to);
  const name = shogiNotationPiece(piece);
  if (action.type === "dropPiece") return `${destination}${name}打`;
  const matching = legalMoves.filter(
    (move) =>
      shogiSamePosition(move.action.to, action.to) && shogiNotationPiece(move.piece) === name,
  );
  const candidates = matching.filter(
    (move, index) =>
      matching.findIndex((other) => shogiSamePosition(other.action.from, move.action.from)) ===
      index,
  );
  const promotion = action.promote
    ? "成"
    : matching.some(
          (move) => move.action.promote && shogiSamePosition(move.action.from, action.from),
        )
      ? "不成"
      : "";
  const direction =
    candidates.length > 1 ? disambiguate(action, piece, candidates, side, allowDragonStraight) : "";
  return `${destination}${name}${direction}${promotion}`;
}

function disambiguate(
  action: NotationMove["action"],
  piece: NotationMove["piece"],
  candidates: readonly NotationMove[],
  side: Side,
  allowDragonStraight: boolean,
) {
  const to = shogiDisplayPosition(action.to, side);
  const origins = candidates.map((move) => shogiDisplayPosition(move.action.from, side));
  const from = shogiDisplayPosition(action.from, side);
  const motion = (origin: Position) => (origin.y > to.y ? "上" : origin.y < to.y ? "引" : "寄");
  const isStraight = (origin: Position) => origin.x === to.x && origin.y > to.y;
  const goldLike =
    piece.kind === "gold" ||
    piece.kind === "silver" ||
    (piece.promoted &&
      (piece.kind === "pawn" || piece.kind === "knight" || piece.kind === "lance"));
  const sliding = piece.kind === "rook" || piece.kind === "bishop";
  const horizontal = (origin: Position): string => {
    if (origin.x < to.x) return "左";
    if (origin.x > to.x) return "右";
    // 龍・馬などの縦移動には「直」を使わず、他候補との位置関係で識別する。
    if (sliding) {
      const others = origins.filter((other) => !shogiSamePosition(other, origin));
      if (others.every((other) => other.x < origin.x)) return "右";
      if (others.every((other) => other.x > origin.x)) return "左";
    }
    return "";
  };
  const unique = (value: string, describe: (origin: Position) => string) =>
    value !== "" && origins.filter((origin) => describe(origin) === value).length === 1;
  let direction = "";
  if (unique(motion(from), motion)) direction = motion(from);
  else if (goldLike && isStraight(from)) direction = "直";
  else if (unique(horizontal(from), horizontal)) direction = horizontal(from);
  else {
    const combined = (origin: Position) =>
      horizontal(origin) ? `${horizontal(origin)}${motion(origin)}` : "";
    if (unique(combined(from), combined)) direction = combined(from);
  }
  // 四人将棋は龍を3枚以上持てる。通常の補助語で区別できない縦移動だけ「直」を使う。
  if (
    !direction &&
    allowDragonStraight &&
    piece.kind === "rook" &&
    piece.promoted &&
    from.x === to.x
  ) {
    const straight = (origin: Position) => (origin.x === to.x ? "直" : "");
    const combined = (origin: Position) =>
      straight(origin) ? `${straight(origin)}${motion(origin)}` : "";
    if (unique("直", straight)) direction = "直";
    else if (unique(combined(from), combined)) direction = combined(from);
  }
  if (!direction) throw new Error("Unable to disambiguate shogi move");
  return direction;
}
