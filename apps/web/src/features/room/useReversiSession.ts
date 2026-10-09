import { getLegalMoves, type Position } from "@tetraboard/reversi";
import { isReversiRoom, type ReversiRoom } from "@tetraboard/protocol";
import { commonSettingsComplete } from "./roomSettingsCompletion";
import { createInitialState } from "@tetraboard/reversi";
import { useRoomTransport, type RoomTransportOptions } from "./useRoomTransport";
import {
  reversiActionComplete,
  reversiOperationError,
  reversiSoundGame,
  reversiSoundMove,
} from "./reversiSessionBehavior";

export function useReversiSession(
  options: Omit<
    RoomTransportOptions<ReversiRoom>,
    "isRoom" | "actionComplete" | "settingsComplete" | "gameOperationError" | "readSoundGame"
  >,
) {
  const session = useRoomTransport({
    ...options,
    isRoom: isReversiRoom,
    actionComplete: reversiActionComplete,
    settingsComplete: commonSettingsComplete,
    gameOperationError: reversiOperationError,
    readSoundGame: reversiSoundGame,
  });
  const { room } = session;
  const self = room.players.find((player) => player.id === session.membership?.playerId);
  const game = room.status === "playing" ? room.game : null;
  const legalMoves = game === null ? [] : getLegalMoves(game);
  const canPlay =
    game?.status === "playing" &&
    self?.color === game.turn &&
    !game.eliminatedColors.includes(game.turn) &&
    session.authenticated &&
    session.connection === "接続済み" &&
    session.pendingGameAction === null;

  return {
    ...session,
    self,
    displayGame:
      room.status === "playing" ? room.game : (room.lastRound?.game ?? createInitialState()),
    legalMoves,
    canPlay,
    handlePlaceStone(position: Position): void {
      if (
        !canPlay ||
        game === null ||
        !legalMoves.some((move) => move.x === position.x && move.y === position.y)
      )
        return;
      const sent = session.sendGameMessage(
        { type: "room.game.action", action: { type: "placeStone", position } },
        { type: "move", moveNumber: game.moveNumber },
      );
      if (sent) session.playOwnMove(reversiSoundMove(position, game.turn));
    },
    handleResignClick(): void {
      if (!canPlay || !self?.color) return;
      session.sendGameMessage(
        { type: "room.game.resign" },
        { type: "resign", participant: self.color },
      );
    },
  };
}
