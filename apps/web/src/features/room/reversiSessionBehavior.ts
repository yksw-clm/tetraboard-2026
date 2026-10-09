import type { Color, Position } from "@tetraboard/reversi";
import type { SoundGameState } from "./roomSoundEvents";
import type { ReversiRoom } from "@tetraboard/protocol";
import { assertNever } from "@tetraboard/protocol";

export type PendingStandardAction =
  | { type: "move"; moveNumber: number }
  | { type: "resign"; participant: Color };

export function reversiActionComplete(room: ReversiRoom, pending: PendingStandardAction): boolean {
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

export function reversiSoundMove(position: Position, color: Color): string {
  return `${color}:${position.x},${position.y}`;
}

export function reversiSoundGame(room: ReversiRoom): SoundGameState {
  const game = room.status === "playing" ? room.game : room.lastRound?.game;
  const color = game?.lastMove ? game.board[game.lastMove.y]?.[game.lastMove.x] : null;
  return {
    phase: room.status === "playing" ? "playing" : game ? "finished" : "waiting",
    roundId: null,
    moveNumber: game?.moveNumber ?? 0,
    lastMove: game?.lastMove && color ? reversiSoundMove(game.lastMove, color) : null,
  };
}
