import type { Color, Position } from "@tetraboard/four-gomoku";
import type { SoundGameState } from "./roomSoundEvents";
import type { FourGomokuRoom } from "@tetraboard/protocol";
import { assertNever } from "@tetraboard/protocol";

export type PendingFourGomokuAction =
  | { type: "move"; roundId: string; positionRevision: number }
  | { type: "resign"; participant: Color };

export function fourGomokuActionComplete(
  room: FourGomokuRoom,
  pending: PendingFourGomokuAction,
): boolean {
  if (room.status === "waiting") return room.lastRound !== null;
  switch (pending.type) {
    case "move":
      return room.roundId !== pending.roundId || room.positionRevision > pending.positionRevision;
    case "resign":
      return room.game.eliminatedColors.includes(pending.participant);
    default:
      return assertNever(pending);
  }
}

export function fourGomokuOperationError(error: string): string | undefined {
  if (error === "invalid_move") return "その場所には石を置けません。";
  if (error === "stale_position") return "局面が更新されました。最新の局面で選び直してください。";
  return undefined;
}

export function fourGomokuSoundMove(position: Position, color: Color): string {
  return `${color}:${position.x},${position.y}`;
}

export function fourGomokuSoundGame(room: FourGomokuRoom): SoundGameState {
  const game = room.status === "playing" ? room.game : room.lastRound?.game;
  const color = game?.lastMove ? game.board[game.lastMove.y]?.[game.lastMove.x] : null;
  return {
    phase: room.status === "playing" ? "playing" : game ? "finished" : "waiting",
    roundId: room.status === "playing" ? room.roundId : (room.lastRound?.replay.id ?? null),
    moveNumber: game?.moveNumber ?? 0,
    lastMove: game?.lastMove && color ? fourGomokuSoundMove(game.lastMove, color) : null,
  };
}
