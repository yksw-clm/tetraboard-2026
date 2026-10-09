import { useState } from "react";
import type { QuarterTurn } from "./boardRotation";
import { FourReversiBoard } from "./FourReversiBoard";
import { ReversiBoardLayout } from "./ReversiBoardLayout";
import { ReversiPlayerCard } from "./ReversiPlayerCard";
import { ReversiResult } from "./ReversiResult";
import { useReversiReplay } from "./reversiReplay";
import { ReplayCard } from "./ReplayCard";
import { RoomViewShell } from "./RoomViewShell";
import type { useReversiSession } from "./useReversiSession";
import type { useRoomChat } from "./useRoomChat";
export function ReversiRoomView({
  session,
  chat,
  invited,
}: {
  session: ReturnType<typeof useReversiSession>;
  chat: ReturnType<typeof useRoomChat>;
  invited: boolean;
}) {
  const { room, membership, presence } = session;
  const [rotation, setRotation] = useState<QuarterTurn>(0);
  const displayRotation = membership ? 0 : rotation;
  const replay = useReversiReplay(room.status === "waiting" ? room.lastRound : null);
  const anchor =
    room.players.find((p) => p.id === membership?.playerId) ??
    (room.status === "playing" ? room.players.find((p) => p.color === "black") : room.players[0]);
  const seats = [anchor ?? null, room.players.find((p) => p.id !== anchor?.id) ?? null];
  const board = (
    <ReversiBoardLayout>
      {seats.map((p, i) => (
        <ReversiPlayerCard
          key={p?.id ?? i}
          player={p}
          position={(i === 0) === (displayRotation === 0) ? "bottom" : "top"}
          self={!!p && p.id === membership?.playerId}
          host={p?.id === presence.hostPlayerId}
          connected={p ? presence.connectedPlayerIds.includes(p.id) : undefined}
          room={room}
          now={session.serverNowMs}
        />
      ))}
      <FourReversiBoard
        label="リバーシの盤面"
        game={replay.frame?.game ?? session.displayGame}
        rotation={displayRotation}
        legalMoves={session.legalMoves}
        canPlay={session.canPlay}
        onPlaceStone={session.handlePlaceStone}
      />
    </ReversiBoardLayout>
  );
  return (
    <RoomViewShell
      session={session}
      chat={chat}
      invited={invited}
      board={board}
      replayCard={replay.frame ? <ReplayCard replay={replay} theme="reversi" /> : null}
      result={room.lastRound ? <ReversiResult lastRound={room.lastRound} /> : null}
      selfEliminated={false}
      onRotate={() => setRotation((r) => (r === 0 ? 2 : 0))}
      operationNotice={
        room.status === "playing" && room.game.consecutivePasses.length
          ? `自動パス：${room.game.consecutivePasses.map((c) => (c === "black" ? "黒" : "白")).join(" → ")}`
          : null
      }
    />
  );
}
