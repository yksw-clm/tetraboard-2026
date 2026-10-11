import { useCallback } from "react";
import { useAppToastQueue } from "../../shared/ui/appToastContext";
import { forbiddenReasons, type Position } from "@tetraboard/gomoku";
import { isGomokuRoom, type GomokuRoom } from "@tetraboard/protocol";
import { commonSettingsComplete } from "./roomSettingsCompletion";
import { createInitialState } from "@tetraboard/gomoku";
import { useRoomTransport, type RoomTransportOptions } from "./useRoomTransport";
import {
  gomokuActionComplete,
  gomokuOperationError,
  gomokuSoundGame,
  forbiddenMessage,
} from "./gomokuSessionBehavior";

export function useGomokuSession(
  options: Omit<
    RoomTransportOptions<GomokuRoom>,
    "isRoom" | "actionComplete" | "settingsComplete" | "gameOperationError" | "readSoundGame"
  >,
) {
  const toast = useAppToastQueue();
  const showForbidden = useCallback(
    (error: string) => {
      if (!error.startsWith("gomoku_")) return false;
      const description = forbiddenMessage(error);
      if (!toast.queue.visibleToasts.some((entry) => entry.content.description === description))
        toast.queue.add(
          { title: "着手できません", description, theme: "gomoku", polite: true },
          { timeout: 3000 },
        );
      return true;
    },
    [toast.queue],
  );
  const session = useRoomTransport({
    ...options,
    isRoom: isGomokuRoom,
    actionComplete: gomokuActionComplete,
    settingsComplete: gomokuSettingsComplete,
    onGameError: showForbidden,
    gameOperationError: gomokuOperationError,
    readSoundGame: gomokuSoundGame,
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
        : (room.lastRound?.game ?? createInitialState(room.settings.forbiddenRules)),
    toast,
    canPlay,
    handlePlaceStone(position: Position): void {
      if (
        !canPlay ||
        game === null ||
        room.status !== "playing" ||
        game.board[position.y]?.[position.x] !== null
      )
        return;
      if (game.turn === "black" && game.forbiddenRules) {
        const reasons = forbiddenReasons(game.board, position);
        if (reasons.length) {
          showForbidden(`gomoku_${reasons.join("_")}`);
          return;
        }
      }
      session.sendGameMessage(
        {
          type: "room.game.action",
          action: { type: "placeGomokuStone", position },
          roundId: room.roundId,
          positionRevision: room.positionRevision,
        },
        { type: "move", roundId: room.roundId, positionRevision: room.positionRevision },
      );
    },
    handleForbiddenChange(enabled: boolean): void {
      session.sendGameSettingsMessage({ type: "room.gomoku-forbidden.set", enabled });
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

const gomokuSettingsComplete: RoomTransportOptions<GomokuRoom>["settingsComplete"] = (
  room,
  command,
  players,
) =>
  command.type === "room.gomoku-forbidden.set"
    ? room.settings.forbiddenRules === command.enabled
    : commonSettingsComplete(room, command, players);
