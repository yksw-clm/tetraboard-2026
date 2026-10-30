import type { AnalysisPosition } from "@tetraboard/four-shogi/analysis";
import type { FourShogiAction, Side, Piece } from "@tetraboard/four-shogi";
import { attacksSquare, isInCheck, pieces } from "../../../../packages/four-shogi/src/board";
import { pieceValue } from "../../../../packages/four-shogi/src/cpuEvaluation";
import { encodeAction } from "../../../../packages/four-shogi/src/actionEncoding";
import { countGuardKingFlights } from "./guardKingFlights";

export type GuardReplyOrdering = "base" | "simple" | "checks" | "escapes";
export function orderGuardReplies(
  position: AnalysisPosition,
  actions: readonly FourShogiAction[],
  root: Side,
  mode: GuardReplyOrdering,
) {
  const score = (action: FourShogiAction) => {
    const taken = position.state.board[action.to.y][action.to.x];
    return (
      (taken?.side === root ? 10000 + pieceValue(taken) : taken ? pieceValue(taken) : 0) +
      (action.type === "movePiece" && action.promote ? 100 : 0)
    );
  };
  if (mode === "base" || position.state.turn === root)
    return [...actions].sort((a, b) => score(b) - score(a) || encodeAction(a) - encodeAction(b));
  const king = pieces(position.state.board).find(
    (p) => p.piece.side === root && p.piece.kind === "king",
  )?.position;
  const values = actions.map((action) => {
    const moving: Piece =
      action.type === "movePiece"
        ? {
            ...position.state.board[action.from.y][action.from.x]!,
            promoted:
              position.state.board[action.from.y][action.from.x]!.promoted || action.promote,
          }
        : { id: -1, side: position.state.turn!, kind: action.pieceKind, promoted: false };
    // 簡易順序は動かした駒の幾何だけ、checksは空き王手も含む盤面の利きを調べます。正本遷移は証明側で行います。
    let checking = !!king && attacksSquare(position.state.board, moving, action.to, king);
    let flights = 9;
    if (mode === "checks" || mode === "escapes") {
      const board = position.state.board.map((row) => [...row]);
      if (action.type === "movePiece") board[action.from.y][action.from.x] = null;
      board[action.to.y][action.to.x] = moving;
      checking = isInCheck({ ...position.state, board }, root);
      if (mode === "escapes" && checking)
        flights = countGuardKingFlights({ ...position.state, board }, root);
    }
    const distance = king
      ? Math.max(Math.abs(king.x - action.to.x), Math.abs(king.y - action.to.y))
      : 9;
    const rookDrop = action.type === "dropPiece" && action.pieceKind === "rook";
    return {
      action,
      checking,
      flights,
      id: encodeAction(action),
      score:
        score(action) +
        (checking ? 100000 : 0) +
        (rookDrop ? 500 + Math.max(0, 5 - distance) * 100 : 0),
    };
  });
  return values
    .sort(
      (a, b) =>
        (mode === "escapes"
          ? Number(b.checking) - Number(a.checking) || a.flights - b.flights
          : 0) ||
        b.score - a.score ||
        a.id - b.id,
    )
    .map((v) => v.action);
}
