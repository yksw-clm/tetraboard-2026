import type { FourShogiAction, Side } from "@tetraboard/four-shogi";
import type { FourShogiPublicState } from "@tetraboard/protocol";
import type { ShogiBoardView } from "./shogiBoardPresentation";

// サーバーが提示した合法手の表示だけを先に進めます。手番・勝敗は確定局面のままです。
export function optimisticShogiBoard(
  game: FourShogiPublicState,
  side: Side,
  action: FourShogiAction,
): ShogiBoardView {
  const board = game.board.map((row) => [...row]);
  const hand = { ...game.hands[side] };
  if (action.type === "movePiece") {
    const piece = board[action.from.y][action.from.x];
    if (piece === null) return game;
    const captured = board[action.to.y][action.to.x];
    if (captured !== null && captured.kind !== "king") hand[captured.kind]++;
    board[action.from.y][action.from.x] = null;
    board[action.to.y][action.to.x] = { ...piece, promoted: piece.promoted || action.promote };
  } else {
    hand[action.pieceKind]--;
    board[action.to.y][action.to.x] = {
      id: game.nextPieceId,
      side,
      kind: action.pieceKind,
      promoted: false,
    };
  }
  return { ...game, board, hands: { ...game.hands, [side]: hand }, lastMove: null };
}
