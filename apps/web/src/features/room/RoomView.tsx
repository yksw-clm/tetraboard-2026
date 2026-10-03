import { FourReversiBoard } from "./FourReversiBoard";
import { GameResultView } from "./GameResultView";
import { RoomBoardLayout } from "./RoomLayout";
import { PlayerCard } from "./PlayerCard";
import { ReplayCard } from "./ReplayCard";
import { RoomViewShell } from "./RoomViewShell";
import { useRoomReplay } from "./useRoomReplay";
import { colorNames, orderedSeats, seatPositions } from "./roomPresentation";
import { type useRoomChat } from "./useRoomChat";
import { type useRoomSession } from "./useRoomSession";

export function RoomView({
  session,
  chat,
  invited,
}: {
  session: ReturnType<typeof useRoomSession>;
  chat: ReturnType<typeof useRoomChat>;
  invited: boolean;
}) {
  const { room, membership, presence } = session;
  const replay = useRoomReplay(room);
  const replayCard = replay.frame ? <ReplayCard replay={replay} /> : null;
  const hasPassNotice = room.status === "playing" && room.game.consecutivePasses.length > 0;
  const board = (
    <RoomBoardLayout hasNotice={hasPassNotice}>
      {orderedSeats(room, membership?.playerId).map((player, index) => (
        <PlayerCard
          key={seatPositions[index]}
          position={seatPositions[index]}
          player={player}
          room={room}
          self={!!player && player.id === membership?.playerId}
          host={!!player && player.id === presence.hostPlayerId}
          connected={!!player && presence.connectedPlayerIds.includes(player.id)}
          now={session.serverNowMs}
        />
      ))}
      <FourReversiBoard
        game={replay.frame?.game ?? session.displayGame}
        legalMoves={session.legalMoves}
        canPlay={session.canPlay}
        onPlaceStone={session.handlePlaceStone}
      />
      {room.status === "playing" && room.game.consecutivePasses.length > 0 && (
        <p
          className="absolute bottom-0 w-full text-center text-[11px] text-[#536d5c] pointer-events-none [@media(max-width:767px)]:static [@media(max-width:767px)]:col-span-full [@media(max-width:767px)]:text-[10px]"
          role="status"
        >
          自動パス：{room.game.consecutivePasses.map((color) => colorNames[color]).join(" → ")}
        </p>
      )}
    </RoomBoardLayout>
  );
  return (
    <RoomViewShell
      session={session}
      chat={chat}
      invited={invited}
      board={board}
      replayCard={replayCard}
      result={room.lastRound && <GameResultView lastRound={room.lastRound} />}
      selfEliminated={
        room.status === "playing" &&
        !!session.self?.color &&
        room.game.eliminatedColors.includes(session.self.color)
      }
    />
  );
}
