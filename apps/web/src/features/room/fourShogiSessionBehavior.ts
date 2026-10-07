import type { FourShogiAction, Side } from "@tetraboard/four-shogi";
import type { FourShogiRoom } from "@tetraboard/protocol";
import { assertNever } from "@tetraboard/protocol";
import type { SoundGameState } from "./roomSoundEvents";

export type PendingShogiAction =
  | {
      type: "move";
      roundId: string;
      positionRevision: number;
      participant: Side;
      action: FourShogiAction;
      startedAtMs: number;
    }
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

export function shogiSoundMove(action: FourShogiAction, side: Side): string {
  switch (action.type) {
    case "movePiece":
      return `${side}:move:${action.from.x},${action.from.y}:${action.to.x},${action.to.y}:${action.promote}`;
    case "dropPiece":
      return `${side}:drop:${action.pieceKind}:${action.to.x},${action.to.y}`;
    default:
      return assertNever(action);
  }
}

export function shogiSoundGame(room: FourShogiRoom): SoundGameState {
  const game = room.status === "playing" ? room.game : room.lastRound?.game;
  return {
    phase: room.status === "playing" ? "playing" : game ? "finished" : "waiting",
    roundId: room.status === "playing" ? room.roundId : (room.lastRound?.roundId ?? null),
    moveNumber: game?.moveNumber ?? 0,
    lastMove: game?.lastMove ? shogiSoundMove(game.lastMove.action, game.lastMove.side) : null,
  };
}
