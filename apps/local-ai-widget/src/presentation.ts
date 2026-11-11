import { pieceNames, type ActiveObservation } from "./model";
import type { FourShogiAction } from "@tetraboard/protocol";
const square = (p: { x: number; y: number }) => `${9 - p.x}${"一二三四五六七八九"[p.y]}`;
export function shogiCandidateLabel(
  action: FourShogiAction,
  o: Extract<ActiveObservation, { gameId: "four-shogi" }>,
): string {
  if (action.type === "dropPiece") return `${square(action.to)} ${pieceNames[action.pieceKind]}打`;
  const piece = o.game.board[action.from.y][action.from.x];
  const promotedNames = { rook: "龍", silver: "成銀", pawn: "と金", gold: "金", king: "王" };
  const name = piece ? (piece.promoted ? promotedNames[piece.kind] : pieceNames[piece.kind]) : "駒";
  return `${square(action.from)} → ${square(action.to)} ${name}${action.promote ? "成" : piece?.promoted || piece?.kind === "king" || piece?.kind === "gold" ? "" : "不成"}`;
}
