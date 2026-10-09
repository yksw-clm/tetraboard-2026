import { canProposeImpasse } from "@tetraboard/shogi";
import type { ShogiAction } from "@tetraboard/shogi";
import { isShogiRoom, type ShogiRoom } from "@tetraboard/protocol";
import { displayShogiGameForRoom } from "./standardShogiRoomPresentation";
import { useRoomTransport, type RoomTransportOptions } from "./useRoomTransport";
import {
  shogiActionComplete,
  shogiSettingsComplete,
  shogiOperationError,
  shogiSoundGame,
  shogiSoundMove,
} from "./fourShogiSessionBehavior";
import { optimisticShogiBoard } from "./optimisticShogiBoard";
import { useDelayedMoveNotice } from "./useDelayedMoveNotice";

export function useShogiRoomSession(
  options: Omit<
    RoomTransportOptions<ShogiRoom>,
    "isRoom" | "actionComplete" | "settingsComplete" | "gameOperationError" | "readSoundGame"
  >,
) {
  const session = useRoomTransport({
    ...options,
    isRoom: isShogiRoom,
    actionComplete: shogiActionComplete,
    settingsComplete: shogiSettingsComplete,
    gameOperationError: shogiOperationError,
    readSoundGame: shogiSoundGame,
  });
  const { room } = session;
  const self = room.players.find((player) => player.id === session.membership?.playerId);
  const canPlay =
    room.status === "playing" &&
    self?.side === room.game.turn &&
    !room.game.eliminations.some((entry) => entry.side === self.side) &&
    session.authenticated &&
    session.connection === "接続済み" &&
    session.pendingGameAction === null;
  const canAct =
    room.status === "playing" &&
    !!self?.side &&
    session.authenticated &&
    session.connection === "接続済み" &&
    session.pendingGameAction === null &&
    !session.leaving;
  const pendingMove =
    room.status === "playing" &&
    session.pendingGameAction?.type === "move" &&
    session.pendingGameAction.roundId === room.roundId &&
    session.pendingGameAction.positionRevision === room.positionRevision &&
    session.pendingGameAction.participant === self?.side &&
    !room.game.eliminations.some((entry) => entry.side === self?.side) &&
    session.authenticated &&
    session.connection === "接続済み" &&
    !session.leaving
      ? session.pendingGameAction
      : null;
  const moveNotice = useDelayedMoveNotice(pendingMove);
  return {
    ...session,
    self,
    canPlay,
    canAct,
    displayGame:
      pendingMove !== null && room.status === "playing"
        ? optimisticShogiBoard(room.game, pendingMove.participant, pendingMove.action)
        : displayShogiGameForRoom(room),
    pendingMove,
    moveNotice,
    handleShogiAction(action: ShogiAction): boolean {
      if (
        !canPlay ||
        !self?.side ||
        room.status !== "playing" ||
        !room.legalActions.some((legal) => JSON.stringify(legal) === JSON.stringify(action))
      )
        return false;
      const sent = session.sendGameMessage(
        {
          type: "room.game.action",
          roundId: room.roundId,
          positionRevision: room.positionRevision,
          action,
        },
        {
          type: "move",
          roundId: room.roundId,
          positionRevision: room.positionRevision,
          participant: self.side,
          action,
          startedAtMs: performance.now(),
        },
      );
      if (sent) session.playOwnMove(shogiSoundMove(action, self.side));
      return sent;
    },
    handleDrawProposalClick(): void {
      if (!canAct || room.status !== "playing" || !self?.side || !canProposeImpasse(room.game))
        return;
      const proposed = !room.game.drawProposals.includes(self.side);
      session.sendGameMessage(
        {
          type: "room.game.draw.set",
          proposed,
          roundId: room.roundId,
          positionRevision: room.positionRevision,
        },
        {
          type: "draw",
          participant: self.side,
          proposed,
          roundId: room.roundId,
          positionRevision: room.positionRevision,
        },
      );
    },
    handleDeclaration(): void {
      if (!canPlay || room.status !== "playing" || !self?.side) return;
      session.sendGameMessage(
        {
          type: "room.game.declare",
          roundId: room.roundId,
          positionRevision: room.positionRevision,
        },
        {
          type: "declare",
          participant: self.side,
          roundId: room.roundId,
          positionRevision: room.positionRevision,
        },
      );
    },
    handleResignClick(): void {
      if (!canPlay || !self?.side) return;
      session.sendGameMessage(
        { type: "room.game.resign" },
        { type: "resign", participant: self.side },
      );
    },
  };
}
