import { type FourShogiAction } from "@tetraboard/four-shogi";
import { type FourShogiRoom } from "@tetraboard/protocol";
import { displayShogiGameForRoom } from "./fourShogiRoomPresentation";
import { useRoomTransport } from "./useRoomTransport";

export function useFourShogiRoomSession(
  options: Parameters<typeof useRoomTransport<FourShogiRoom>>[0],
) {
  const session = useRoomTransport(options);
  const { room } = session;
  const self = room.players.find((player) => player.id === session.membership?.playerId);
  const canPlay =
    room.status === "playing" &&
    self?.side === room.game.turn &&
    !room.game.eliminations.some((entry) => entry.side === self.side) &&
    session.authenticated &&
    session.connection === "接続済み" &&
    session.pendingGameAction === null;
  return {
    ...session,
    self,
    canPlay,
    displayGame: displayShogiGameForRoom(room),
    handleShogiAction(action: FourShogiAction): void {
      if (
        !canPlay ||
        room.status !== "playing" ||
        !room.legalActions.some((legal) => JSON.stringify(legal) === JSON.stringify(action))
      )
        return;
      session.sendGameMessage(
        {
          type: "room.game.action",
          roundId: room.roundId,
          positionRevision: room.positionRevision,
          action,
        },
        {
          type: "move",
          moveNumber: room.game.moveNumber,
          roundId: room.roundId,
          positionRevision: room.positionRevision,
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
