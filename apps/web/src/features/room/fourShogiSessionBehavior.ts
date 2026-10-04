import type { Side } from "@tetraboard/four-shogi";
import type { FourShogiRoom } from "@tetraboard/protocol";
import { assertNever } from "@tetraboard/protocol";

export type PendingShogiAction =
  | { type: "move"; roundId: string; positionRevision: number }
  | { type: "resign"; participant: Side }
  | {
      type: "draw";
      participant: Side;
      proposed: boolean;
      roundId: string;
      positionRevision: number;
    };

export function shogiActionComplete(room: FourShogiRoom, pending: PendingShogiAction): boolean {
  if (room.status === "waiting") return pending.type === "draw" || room.lastRound !== null;
  switch (pending.type) {
    case "move":
      return room.roundId !== pending.roundId || room.positionRevision > pending.positionRevision;
    case "resign":
      return room.game.eliminations.some((entry) => entry.side === pending.participant);
    case "draw":
      return (
        room.roundId !== pending.roundId ||
        room.positionRevision > pending.positionRevision ||
        room.game.drawProposals.includes(pending.participant) === pending.proposed
      );
    default:
      return assertNever(pending);
  }
}

export function shogiOperationError(error: string): string | undefined {
  if (error === "invalid_move") return "その手は指せません。最新の局面で選び直してください。";
  if (error === "stale_position") return "局面が更新されました。最新の局面で選び直してください。";
  return undefined;
}
