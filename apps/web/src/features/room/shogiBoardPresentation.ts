import type { Board, FourShogiAction, HandPieceKind, Hands, Position, Side } from "./shogiUiTypes";

export function shogiPieceLiftClasses(selected: boolean): string {
  // 着手時に画像のfilter・transformを切り替えず、浮き上がりは位置だけで表現します。
  return `relative ${selected ? "-top-[2px]" : "group-hover/shogi-piece:-top-[2px]"}`;
}

export const shogiSides = ["south", "west", "north", "east"] as const;
export const shogiSideNames: Record<Side, string> = {
  south: "南",
  west: "西",
  north: "北",
  east: "東",
};
export const shogiPieceNames = {
  king: "王",
  rook: "飛車",
  bishop: "角",
  knight: "桂",
  lance: "香",
  gold: "金",
  silver: "銀",
  pawn: "歩",
} as const;
export type ShogiPlacement = "bottom" | "left" | "top" | "right";
export type ShogiPieceDirection = "up" | "right" | "down" | "left";
export type ShogiBoardView = {
  mode?: "singles" | "doubles";
  status: "playing" | "finished";
  turn: Side | null;
} & {
  board: Board;
  hands: Hands;
  eliminations: readonly Readonly<{ side: Side }>[];
  lastMove: Readonly<{ action: FourShogiAction }> | null;
};
export type ShogiSelection =
  | Readonly<{ type: "movePiece"; from: Position }>
  | Readonly<{ type: "dropPiece"; pieceKind: HandPieceKind }>;

const placements: readonly ShogiPlacement[] = ["bottom", "left", "top", "right"];
const directions: Record<ShogiPlacement, ShogiPieceDirection> = {
  bottom: "up",
  left: "right",
  top: "down",
  right: "left",
};

export function shogiSidePlacement(side: Side, viewerSide: Side): ShogiPlacement {
  return placements[(shogiSides.indexOf(side) - shogiSides.indexOf(viewerSide) + 4) % 4];
}

export function shogiPieceDirection(side: Side, viewerSide: Side): ShogiPieceDirection {
  return directions[shogiSidePlacement(side, viewerSide)];
}

export function shogiDisplayPosition(position: Position, viewerSide: Side): Position {
  switch (viewerSide) {
    case "south":
      return { ...position };
    case "west":
      return { x: position.y, y: 8 - position.x };
    case "north":
      return { x: 8 - position.x, y: 8 - position.y };
    case "east":
      return { x: 8 - position.y, y: position.x };
  }
}

export function shogiBoardPosition(position: Position, viewerSide: Side): Position {
  switch (viewerSide) {
    case "south":
      return { ...position };
    case "west":
      return { x: 8 - position.y, y: position.x };
    case "north":
      return { x: 8 - position.x, y: 8 - position.y };
    case "east":
      return { x: position.y, y: 8 - position.x };
  }
}

export function shogiBoardPositionAtPoint(
  point: Position,
  rectangle: Readonly<{ left: number; top: number; width: number; height: number }>,
  viewerSide: Side,
): Position | null {
  if (
    rectangle.width <= 0 ||
    rectangle.height <= 0 ||
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y) ||
    point.x < rectangle.left ||
    point.x >= rectangle.left + rectangle.width ||
    point.y < rectangle.top ||
    point.y >= rectangle.top + rectangle.height
  ) {
    return null;
  }
  return shogiBoardPosition(
    {
      x: Math.floor(((point.x - rectangle.left) / rectangle.width) * 9),
      y: Math.floor(((point.y - rectangle.top) / rectangle.height) * 9),
    },
    viewerSide,
  );
}

export function shogiSamePosition(left: Position, right: Position): boolean {
  return left.x === right.x && left.y === right.y;
}

export function shogiSameSelection(left: ShogiSelection, right: ShogiSelection): boolean {
  return left.type === "movePiece" && right.type === "movePiece"
    ? shogiSamePosition(left.from, right.from)
    : left.type === "dropPiece" && right.type === "dropPiece" && left.pieceKind === right.pieceKind;
}

export function shogiActionChoices(
  legalActions: readonly FourShogiAction[],
  selection: ShogiSelection,
  destination: Position,
): FourShogiAction[] {
  return legalActions.filter(
    (action) =>
      shogiSamePosition(action.to, destination) &&
      (action.type === "movePiece" && selection.type === "movePiece"
        ? shogiSamePosition(action.from, selection.from)
        : action.type === "dropPiece" &&
          selection.type === "dropPiece" &&
          action.pieceKind === selection.pieceKind),
  );
}

export function shogiDragThresholdReached(start: Position, current: Position): boolean {
  return Math.hypot(current.x - start.x, current.y - start.y) >= 8;
}
