import { getActiveSides, handPieceKinds, sides, usesAttackRestriction } from "./types";
import type { FourShogiState } from "./types";

/** Read-only base history, stable for one transition/search; missing keys return zero.
 * With a lookup, state.repetitions holds branch-local overrides, not the complete history.
 */
export type RepetitionLookup = (positionKey: string) => number;

export function positionKey(state: FourShogiState): string {
  const active = getActiveSides(state);
  const board = state.board.map((row) =>
    row.map((piece) => (piece === null ? null : [piece.side, piece.kind, piece.promoted])),
  );
  const hands = active.map((side) => [side, handPieceKinds.map((kind) => state.hands[side][kind])]);
  const positions = new Map<number, number>();
  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 9; x++) {
      const piece = state.board[y][x];
      if (piece !== null) positions.set(piece.id, y * 9 + x);
    }
  }
  // 識別子そのものではなく、履歴が現在のどの盤上駒を指すかを比較します。
  const attacks = usesAttackRestriction(state)
    ? [...state.attackRelations]
        .sort(
          (left, right) =>
            sides.indexOf(left.attacker) - sides.indexOf(right.attacker) ||
            sides.indexOf(left.target) - sides.indexOf(right.target),
        )
        .map((relation) => [
          relation.attacker,
          relation.target,
          [...new Set(relation.reasons)].sort(),
          [
            ...new Set(
              relation.targetPieceIds.flatMap((id) =>
                positions.has(id) ? [positions.get(id)!] : [],
              ),
            ),
          ].sort((a, b) => a - b),
          sides.filter((side) => relation.pendingSides.includes(side)),
        ])
    : [];
  const recaptures = usesAttackRestriction(state)
    ? sides.map((side) =>
        [...new Set(state.recaptureSquares[side].map(({ x, y }) => y * 9 + x))].sort(
          (a, b) => a - b,
        ),
      )
    : [];
  return JSON.stringify([board, hands, active, state.turn, attacks, recaptures]);
}

export function recordPosition(state: FourShogiState, lookup?: RepetitionLookup): FourShogiState {
  if (state.status === "finished") return state;
  const key = positionKey(state);
  return {
    ...state,
    repetitions: {
      ...state.repetitions,
      [key]: (state.repetitions[key] ?? lookup?.(key) ?? 0) + 1,
    },
  };
}

export function isRepetition(state: FourShogiState): boolean {
  return state.status === "playing" && (state.repetitions[positionKey(state)] ?? 0) >= 4;
}
