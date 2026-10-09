import { inPromotionZone, isInCheck, pieces } from "./board";
import { defeat, finish } from "./results";
import {
  handPieceKinds,
  otherSide,
  sides,
  type ApplyActionResult,
  type PieceKind,
  type ShogiState,
  type Side,
} from "./types";
export function piecePoints(kind: PieceKind): number {
  return kind === "king" ? 0 : kind === "rook" || kind === "bishop" ? 5 : 1;
}
export function impassePoints(state: ShogiState, side: Side, enemyOnly = false): number {
  const hand = handPieceKinds.reduce(
    (n, kind) => n + state.hands[side][kind] * piecePoints(kind),
    0,
  );
  return (
    hand +
    pieces(state.board)
      .filter((p) => p.piece.side === side && (!enemyOnly || inPromotionZone(side, p.position)))
      .reduce((n, p) => n + piecePoints(p.piece.kind), 0)
  );
}
export function canProposeImpasse(state: Pick<ShogiState, "board" | "status">): boolean {
  return (
    state.status === "playing" &&
    !sides.some((s) => isInCheck(state, s)) &&
    pieces(state.board).some(
      (p) => p.piece.kind === "king" && inPromotionZone(p.piece.side, p.position),
    )
  );
}
export function declarationStatus(state: ShogiState, side: Side) {
  const own = pieces(state.board).filter(
    (p) => p.piece.side === side && inPromotionZone(side, p.position),
  );
  const kingInZone = own.some((p) => p.piece.kind === "king");
  const count = own.filter((p) => p.piece.kind !== "king").length;
  const points = impassePoints(state, side, true);
  const eligible =
    state.status === "playing" &&
    state.moveNumber < 500 &&
    kingInZone &&
    count >= 10 &&
    !isInCheck(state, side) &&
    points >= 24;
  return {
    kingInZone,
    count,
    points,
    eligible,
    outcome: eligible ? (points >= 31 ? ("win" as const) : ("draw" as const)) : ("loss" as const),
  };
}
export function declareEnteringKing(state: ShogiState, side: Side): ApplyActionResult {
  if (state.status === "finished") return { ok: false, reason: "game_finished" };
  if (state.turn !== side) return { ok: false, reason: "not_your_turn" };
  const status = declarationStatus(state, side);
  const next = !status.eligible
    ? defeat(state, side, "invalid_declaration")
    : finish(state, { winner: status.outcome === "win" ? side : null, reason: "declaration" });
  return { ok: true, state: next, captured: null, eliminations: next.eliminations };
}
export function setDrawProposal(
  state: ShogiState,
  side: Side,
  proposed: boolean,
): ApplyActionResult {
  if (state.status === "finished") return { ok: false, reason: "game_finished" };
  if (typeof proposed !== "boolean") return { ok: false, reason: "invalid_proposal" };
  if (proposed && !canProposeImpasse(state)) return { ok: false, reason: "impasse_unavailable" };
  if (state.drawProposals.includes(side) === proposed)
    return { ok: true, state, captured: null, eliminations: state.eliminations };
  const drawProposals = sides.filter((s) =>
    s === side ? proposed : state.drawProposals.includes(s),
  );
  let next: ShogiState = { ...state, drawProposals };
  if (drawProposals.length === 2) {
    const loser = sides.find((s) => impassePoints(state, s) < 24);
    next = loser
      ? defeat(next, loser, "impasse")
      : finish(next, { winner: null, reason: "impasse" });
  }
  return { ok: true, state: next, captured: null, eliminations: next.eliminations };
}
export function settleMoveLimit(state: ShogiState): ShogiState {
  return state.status === "playing" && state.moveNumber >= 500 && !isInCheck(state, state.turn)
    ? finish(state, { winner: null, reason: "move_limit" })
    : state;
}
export { otherSide };
