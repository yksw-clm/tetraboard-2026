import type { FourShogiState, Piece, PieceKind, Position, Side } from "../packages/four-shogi/src";

// 承認済みの完成図を独立に固定します。解析器の定義から期待局面を生成しません。
export const formationCases = [
  {
    id: "tenshukaku",
    name: "天守閣玉",
    before: "F8",
    pieces: {
      king: ["E7"],
      rook: ["E8"],
      gold: ["D9", "F9"],
      silver: ["C9", "G9"],
      pawn: ["D7", "E6", "F7"],
    },
  },
  {
    id: "subway-rook",
    name: "地下鉄飛車",
    before: "E8",
    pieces: {
      king: ["F8"],
      rook: ["E9"],
      gold: ["F9", "G8"],
      silver: ["C9", "G9"],
      pawn: ["D8", "E7", "F7"],
    },
  },
  {
    id: "right-king",
    name: "右玉",
    before: "H8",
    pieces: {
      king: ["I9"],
      rook: ["E8"],
      gold: ["D9", "H9"],
      silver: ["C9", "I8"],
      pawn: ["D8", "E7", "F7"],
    },
  },
  {
    id: "e-shape",
    name: "エの字",
    before: "F8",
    pieces: {
      king: ["E9"],
      rook: ["E8"],
      gold: ["D9", "F9"],
      silver: ["C9", "G9"],
      pawn: ["D7", "E7", "F7"],
    },
  },
  {
    id: "riggtosfar",
    name: "リッグトスファー",
    before: "F8",
    pieces: {
      king: ["E8"],
      rook: ["F9"],
      gold: ["D9", "G8"],
      silver: ["D8", "G9"],
      pawn: ["D7", "E7", "F6"],
    },
  },
  {
    id: "floating-rook",
    name: "浮き飛車",
    before: "E8",
    pieces: {
      king: ["F8"],
      rook: ["E7"],
      gold: ["C8", "F9"],
      silver: ["C9", "G9"],
      pawn: ["D8", "E6", "F7"],
    },
  },
] as const;
export type FixtureFormationId = (typeof formationCases)[number]["id"];

export function formationSquare(square: string, side: Side): Position {
  let x = square.charCodeAt(0) - 65;
  let y = Number(square[1]) - 1;
  const turns = { south: 0, west: 1, north: 2, east: 3 }[side];
  for (let turn = 0; turn < turns; turn++) [x, y] = [8 - y, x];
  return { x, y };
}

export function formationState(
  initial: FourShogiState,
  id: FixtureFormationId,
  side: Side = "south",
  complete = true,
): FourShogiState {
  const fixture = formationCases.find((entry) => entry.id === id)!;
  const board: (Piece | null)[][] = Array.from({ length: 9 }, () =>
    Array<Piece | null>(9).fill(null),
  );
  let pieceId = 1;
  for (const row of initial.board)
    for (const piece of row) {
      if (!piece || piece.kind !== "king" || piece.side === side) continue;
      const y = initial.board.indexOf(row);
      board[y][row.indexOf(piece)] = { ...piece, id: pieceId++ };
    }
  for (const [kind, squares] of Object.entries(fixture.pieces))
    for (const square of squares) {
      const { x, y } = formationSquare(
        !complete && kind === "king" ? fixture.before : square,
        side,
      );
      board[y][x] = { id: pieceId++, side, kind: kind as PieceKind, promoted: false };
    }
  return {
    ...initial,
    status: "playing",
    result: null,
    turn: side,
    board,
    nextPieceId: pieceId,
    repetitions: {},
  };
}

export function formationAction(id: FixtureFormationId, side: Side = "south") {
  const fixture = formationCases.find((entry) => entry.id === id)!;
  return {
    type: "movePiece" as const,
    from: formationSquare(fixture.before, side),
    to: formationSquare(fixture.pieces.king[0], side),
    promote: false,
  };
}
