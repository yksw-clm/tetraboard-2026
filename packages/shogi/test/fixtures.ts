import { createInitialState, type Cell, type ShogiState } from "../src";
const initial = () => createInitialState({ players: { south: "a", north: "b" } });
export function position(entries: readonly [number, number, NonNullable<Cell>][] = []): ShogiState {
  const state = initial(),
    board: Cell[][] = Array.from({ length: 9 }, () => Array<Cell>(9).fill(null));
  board[8][4] = { id: 1, side: "south", kind: "king", promoted: false };
  board[0][4] = { id: 2, side: "north", kind: "king", promoted: false };
  for (const [x, y, p] of entries) board[y][x] = p;
  return { ...state, board, nextPieceId: 100 };
}
