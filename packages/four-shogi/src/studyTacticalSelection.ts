import { attacksSquare, pieces } from "./board";
import { getActiveSides, type FourShogiState, type Side } from "./types";

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
