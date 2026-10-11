import { type Position } from "@tetraboard/four-gomoku";
import { isFourGomokuRoom, type FourGomokuRoom } from "@tetraboard/protocol";
import { commonSettingsComplete } from "./roomSettingsCompletion";
import { createInitialState } from "@tetraboard/four-gomoku";
import { useRoomTransport, type RoomTransportOptions } from "./useRoomTransport";
import {
  fourGomokuActionComplete,
  fourGomokuOperationError,
  fourGomokuSoundGame,
} from "./fourGomokuSessionBehavior";

export function useFourGomokuSession(
  options: Omit<
    RoomTransportOptions<FourGomokuRoom>,
    "isRoom" | "actionComplete" | "settingsComplete" | "gameOperationError" | "readSoundGame"
  >,
) {
  const session = useRoomTransport({
    ...options,
    isRoom: isFourGomokuRoom,
    actionComplete: fourGomokuActionComplete,
    settingsComplete: commonSettingsComplete,
    gameOperationError: fourGomokuOperationError,
    readSoundGame: fourGomokuSoundGame,
  });
  const { room } = session;
  const self = room.players.find((player) => player.id === session.membership?.playerId);
  const game = room.status === "playing" ? room.game : null;

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
      room.status === "playing"
        ? room.game
        : (room.lastRound?.game ?? createInitialState(room.settings.mode)),
    canPlay,
    handlePlaceStone(position: Position): void {
      if (
        !canPlay ||
        game === null ||
        room.status !== "playing" ||
        game.board[position.y]?.[position.x] !== null
      )
        return;
      session.sendGameMessage(
        {
          type: "room.game.action",
          action: { type: "placeFourGomokuStone", position },
          roundId: room.roundId,
          positionRevision: room.positionRevision,
        },
        { type: "move", roundId: room.roundId, positionRevision: room.positionRevision },
      );
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
