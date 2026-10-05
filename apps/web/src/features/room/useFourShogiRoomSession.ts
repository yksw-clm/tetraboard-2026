import type { FourShogiAction } from "@tetraboard/four-shogi";
import { isFourShogiRoom, type FourShogiRoom } from "@tetraboard/protocol";
import { displayShogiGameForRoom } from "./fourShogiRoomPresentation";
import { useRoomTransport, type RoomTransportOptions } from "./useRoomTransport";
import { shogiActionComplete, shogiOperationError } from "./fourShogiSessionBehavior";
import { optimisticShogiBoard } from "./optimisticShogiBoard";
import { useDelayedMoveNotice } from "./useDelayedMoveNotice";

export function useFourShogiRoomSession(
  options: Omit<
    RoomTransportOptions<FourShogiRoom>,
    "isRoom" | "actionComplete" | "gameOperationError"
  >,
) {
  const session = useRoomTransport({
    ...options,
    isRoom: isFourShogiRoom,
    actionComplete: shogiActionComplete,
    gameOperationError: shogiOperationError,
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
    displayGame:
      pendingMove !== null && room.status === "playing"
        ? optimisticShogiBoard(room.game, pendingMove.participant, pendingMove.action)
        : displayShogiGameForRoom(room),
    pendingMove,
    moveNotice,
    changeThreePlayerAttack(prohibited: boolean): void {
      session.sendGameSettingsMessage({ type: "room.three-player-attack.set", prohibited });
    },
    handleShogiAction(action: FourShogiAction): boolean {
      if (
        !canPlay ||
        !self?.side ||
        room.status !== "playing" ||
        !room.legalActions.some((legal) => JSON.stringify(legal) === JSON.stringify(action))
      )
        return false;
      return session.sendGameMessage(
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
    },
    handleDrawProposalClick(): void {
      if (!canPlay || room.status !== "playing" || !self?.side) return;
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
    handleResignClick(): void {
      if (!canPlay || !self?.side) return;
      session.sendGameMessage(
        { type: "room.game.resign" },
        { type: "resign", participant: self.side },
      );
    },
  };
}
