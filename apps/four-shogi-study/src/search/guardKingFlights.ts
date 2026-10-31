import type { FourShogiState, Side } from "@tetraboard/four-shogi";
import { pieces, isInCheck, inBounds } from "../../../../packages/four-shogi/src/board";

/** 順序付け用の幾何的な王の退路数です。合駒などの全回避手や詰みの判定には使いません。 */
export function countGuardKingFlights(state: FourShogiState, root: Side): number {
  const king = pieces(state.board).find((p) => p.piece.side === root && p.piece.kind === "king");
  if (!king) return 0;
  const board = state.board.map((row) => [...row]);
  board[king.position.y][king.position.x] = null;
  let count = 0;
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const to = { x: king.position.x + dx, y: king.position.y + dy };
      if (!inBounds(to)) continue;
      const taken = board[to.y][to.x];
      if (taken?.side === root || taken?.kind === "king") continue;
      board[to.y][to.x] = king.piece;
      if (!isInCheck({ ...state, board }, root)) count++;
      board[to.y][to.x] = taken;
    }
  return count;
}
