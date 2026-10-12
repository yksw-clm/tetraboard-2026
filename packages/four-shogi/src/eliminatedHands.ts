import { sides } from "./types";
import type { FourShogiState, Hand, Side } from "./types";

export type EliminatedHands = Readonly<Partial<Record<Side, Hand>>>;
type Position = Pick<FourShogiState, "hands" | "eliminations" | "moveNumber" | "lastMove">;

/** ルール上の持ち駒を変更せず、今回脱落した陣営の表示用枚数を確定します。 */
export function captureEliminatedHands(
  previous: EliminatedHands,
  before: Position,
  after: Position,
): EliminatedHands {
  const active = sides.filter((side) => !before.eliminations.some((entry) => entry.side === side));
  const eliminated = after.eliminations.filter((entry) => active.includes(entry.side));
  if (eliminated.length === 0) return previous;
  const hands = { ...previous };
  for (const { side } of eliminated) {
    const hand = { ...before.hands[side] };
    const move = after.moveNumber > before.moveNumber ? after.lastMove : null;
    if (move?.side === side) {
      if (move.action.type === "dropPiece") hand[move.action.pieceKind]--;
      if (move.captured && move.captured.kind !== "king") hand[move.captured.kind]++;
    }
    hands[side] = hand;
  }
  return hands;
}
