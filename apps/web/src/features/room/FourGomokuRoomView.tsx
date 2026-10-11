import { useBoardRotation } from "./useBoardRotation";
import { rotatedSeatIndex } from "./boardRotation";
import { seatPositions } from "./roomCommonPresentation";
import { fourGomokuRoomSeats } from "./fourGomokuPresentation";
import { GomokuBoard } from "./GomokuBoard";
import { RoomBoardLayout } from "./RoomLayout";
import { FourGomokuPlayerCard } from "./FourGomokuPlayerCard";
import { FourGomokuResult } from "./FourGomokuResult";
import { useFourGomokuReplay } from "./fourGomokuReplay";
import { ReplayCard } from "./ReplayCard";
import { RoomViewShell } from "./RoomViewShell";
import type { useFourGomokuSession } from "./useFourGomokuSession";
import type { useRoomChat } from "./useRoomChat";
export function FourGomokuRoomView({
  session,
  chat,
  invited,
}: {
  session: ReturnType<typeof useFourGomokuSession>;
  chat: ReturnType<typeof useRoomChat>;
  invited: boolean;
}) {
  const { room, membership, presence } = session;
  const { rotation, rotate } = useBoardRotation();
  const displayRotation = membership ? 0 : rotation;
  const replay = useFourGomokuReplay(room.status === "waiting" ? room.lastRound : null);
  const board = (
    <RoomBoardLayout hasNotice={false}>
      {fourGomokuRoomSeats(room, membership?.playerId).map((p, i) => (
        <FourGomokuPlayerCard
          key={p?.id ?? i}
          player={p}
          position={seatPositions[rotatedSeatIndex(i, displayRotation)]}
          self={!!p && p.id === membership?.playerId}
          host={p?.id === presence.hostPlayerId}
          connected={p ? presence.connectedPlayerIds.includes(p.id) : undefined}
          room={room}
          now={session.serverNowMs}
        />
      ))}
      <GomokuBoard
        label="四人五目並べの盤面"
        game={replay.frame?.game ?? session.displayGame}
        rotation={displayRotation}
        canPlay={session.canPlay}
        onPlaceStone={session.handlePlaceStone}
      />
    </RoomBoardLayout>
  );
  const inactive =
    room.status === "playing" &&
    !!session.self?.color &&
    (room.game.eliminatedColors.includes(session.self.color) ||
      room.game.completedColors.includes(session.self.color));
  return (
    <RoomViewShell
      session={session}
      chat={chat}
      invited={invited}
      board={board}
      replayCard={replay.frame ? <ReplayCard replay={replay} theme="gomoku" /> : null}
      result={room.lastRound ? <FourGomokuResult lastRound={room.lastRound} /> : null}
      selfEliminated={inactive}
      onRotate={rotate}
      operationNotice={room.settings.mode === "doubles" ? "チーム：黒・赤 対 白・青" : undefined}
    />
  );
}
