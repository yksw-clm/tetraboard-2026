import { attacksSquare, pieces, getCheckState } from "./board";
import { pieceValue } from "./cpuEvaluation";
import type { OrdinaryMove } from "./moves";
import { getActiveSides, handPieceKinds, type FourShogiState, type Side } from "./types";

export type StudyQuiescenceReason = "check" | "recapture" | "valuable_capture";
const valuableCapture = Math.min(
  ...handPieceKinds
    .filter((kind) => kind !== "pawn")
    .map((kind) => pieceValue({ id: 0, side: "south", kind, promoted: false })),
);

export function studyQuiescenceReason(
  state: FourShogiState,
  checks = getCheckState(state),
): StudyQuiescenceReason | null {
  if (state.status === "finished") return null;
  if (getActiveSides(state).some((side) => checks[side])) return "check";
  const board = pieces(state.board);
  const last = state.lastMove;
  let availableCapture = false;
  for (const target of board) {
    if (target.piece.side === state.turn || target.piece.kind === "king") continue;
    const contested = Boolean(
      last &&
      (last.captured || (last.action.type === "movePiece" && last.action.promote)) &&
      last.action.to.x === target.position.x &&
      last.action.to.y === target.position.y,
    );
    if (!contested && pieceValue(target.piece) < valuableCapture) continue;
    if (
      board.some(
        (attacker) =>
          attacker.piece.side === state.turn &&
          attacksSquare(state.board, attacker.piece, attacker.position, target.position),
      )
    )
      if (contested) return "recapture";
      else availableCapture = true;
  }
  return availableCapture ? "valuable_capture" : null;
}

/** 仮パスを作らず、静かな手も実際の合法着手で比較します。 */
export function selectStudyQuiescenceMoves<
  T extends { move: OrdinaryMove; index: number; score: number },
>(ordered: readonly T[], state: FourShogiState, checked: boolean): T[] {
  if (checked) return [...ordered];
  const selected: T[] = [];
  const add = (entry: T | undefined) => {
    if (entry && !selected.includes(entry)) selected.push(entry);
  };
  const last = state.lastMove;
  const recapture = ordered.find(
    (entry) =>
      entry.move.captured &&
      last &&
      entry.move.action.to.x === last.action.to.x &&
      entry.move.action.to.y === last.action.to.y,
  );
  add(recapture ?? ordered.find((entry) => entry.move.captured));
  add(
    ordered.find((entry) => !selected.includes(entry) && entry.score >= 10000) ??
      ordered.find(
        (entry) =>
          !selected.includes(entry) &&
          entry.move.action.type === "movePiece" &&
          entry.move.action.promote,
      ),
  );
  add(
    ordered.find(
      (entry) =>
        !entry.move.captured &&
        entry.score < 10000 &&
        !(entry.move.action.type === "movePiece" && entry.move.action.promote),
    ),
  );
  return selected;
}

/** 距離だけが違う同じ王手筋に、狭い探索枠が占有されるのを観測します。 */
export function studyCheckingRays(state: FourShogiState, side: Side): string[] {
  const board = pieces(state.board);
  const active = getActiveSides(state);
  const rays = new Set<string>();
  for (const target of board) {
    if (
      target.piece.kind !== "king" ||
      target.piece.side === side ||
      !active.includes(target.piece.side)
    )
      continue;
    for (const attacker of board) {
      if (
        attacker.piece.side !== side ||
        !attacksSquare(state.board, attacker.piece, attacker.position, target.position)
      )
        continue;
      rays.add(
        JSON.stringify([
          target.piece.side,
          attacker.piece.kind,
          attacker.piece.promoted,
          Math.sign(attacker.position.x - target.position.x),
          Math.sign(attacker.position.y - target.position.y),
        ]),
      );
    }
  }
  return [...rays].sort();
}
