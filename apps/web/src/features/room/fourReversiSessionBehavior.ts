import type { Color } from "@tetraboard/four-reversi";
import type { FourReversiRoom } from "@tetraboard/protocol";
import { assertNever } from "@tetraboard/protocol";

export type PendingReversiAction =
  | { type: "move"; moveNumber: number }
  | { type: "resign"; participant: Color };

export function reversiActionComplete(
  room: FourReversiRoom,
  pending: PendingReversiAction,
): boolean {
  if (room.status === "waiting") return room.lastRound !== null;
  switch (pending.type) {
    case "move":
      return room.game.moveNumber > pending.moveNumber;
    case "resign":
      return room.game.eliminatedColors.includes(pending.participant);
    default:
      return assertNever(pending);
  }
}

export function reversiOperationError(error: string): string | undefined {
  if (error === "invalid_move") return "その場所には石を置けません。";
  if (error === "stale_position") return "局面が更新されました。最新の局面で選び直してください。";
  return undefined;
}
