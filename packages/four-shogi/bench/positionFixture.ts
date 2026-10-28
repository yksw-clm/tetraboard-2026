import { createInitialState } from "../src/index";
import type {
  AttackRelation,
  Elimination,
  FourShogiAction,
  FourShogiState,
  GameMode,
  Hand,
  HandPieceKind,
  PieceKind,
  Position,
  Side,
} from "../src/index";

export function position(square: string): Position {
  return { x: square.charCodeAt(0) - 65, y: Number(square.slice(1)) - 1 };
}

export function move(from: string, to: string, promote = false): FourShogiAction {
  return { type: "movePiece", from: position(from), to: position(to), promote };
}

export function drop(pieceKind: HandPieceKind, to: string): FourShogiAction {
  return { type: "dropPiece", pieceKind, to: position(to) };
}

export type FixturePiece = {
  side: Side;
  kind: PieceKind;
  at: string;
  promoted?: boolean;
  id?: number;
};

export type FixtureOptions = {
  turn?: Side;
  mode?: GameMode;
  threePlayerAttackProhibited?: boolean;
  pieces?: readonly FixturePiece[];
  kings?: Partial<Record<Side, string>>;
  hands?: Partial<Record<Side, Partial<Hand>>>;
  attackRelations?: readonly AttackRelation[];
  recaptureSquares?: Partial<Record<Side, readonly Position[]>>;
  eliminations?: readonly Elimination[];
};

export function fixture(options: FixtureOptions = {}): FourShogiState {
  const base = createInitialState({
    mode: options.mode ?? "singles",
    players: { south: "s", west: "w", north: "n", east: "e" },
    threePlayerAttackProhibited: options.threePlayerAttackProhibited ?? false,
  });
  const board = Array.from({ length: 9 }, () =>
    Array<FourShogiState["board"][number][number]>(9).fill(null),
  );
  const kings: Record<Side, string> = {
    south: "A9",
    west: "A1",
    north: "I1",
    east: "I9",
    ...options.kings,
  };
  let nextId = 100;
  for (const side of ["south", "west", "north", "east"] as const) {
    const at = position(kings[side]);
    board[at.y][at.x] = { id: nextId++, side, kind: "king", promoted: false };
  }
  for (const entry of options.pieces ?? []) {
    if (entry.kind === "king") {
      const old = position(kings[entry.side]);
      board[old.y][old.x] = null;
    }
    const at = position(entry.at);
    const id = entry.id ?? nextId++;
    nextId = Math.max(nextId, id + 1);
    board[at.y][at.x] = {
      id,
      side: entry.side,
      kind: entry.kind,
      promoted: entry.promoted ?? false,
    };
  }
  return {
    ...base,
    status: "playing",
    result: null,
    turn: options.turn ?? "south",
    board,
    hands: {
      south: { ...base.hands.south, ...options.hands?.south },
      west: { ...base.hands.west, ...options.hands?.west },
      north: { ...base.hands.north, ...options.hands?.north },
      east: { ...base.hands.east, ...options.hands?.east },
    },
    nextPieceId: nextId,
    eliminations: options.eliminations ?? [],
    attackRelations: options.attackRelations ?? [],
    recaptureSquares: { ...base.recaptureSquares, ...options.recaptureSquares },
    repetitions: {},
  };
}
