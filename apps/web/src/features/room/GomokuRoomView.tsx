import { AppToastRegion } from "../../shared/ui/AppToastRegion";
import { GomokuForbiddenControl } from "../lobby/GomokuForbiddenControl";
import { useState } from "react";
import type { QuarterTurn } from "./boardRotation";
import { GomokuBoard } from "./GomokuBoard";
import { ReversiBoardLayout } from "./ReversiBoardLayout";
import { GomokuPlayerCard } from "./GomokuPlayerCard";
import { GomokuResult } from "./GomokuResult";
import { useGomokuReplay } from "./gomokuReplay";
import { ReplayCard } from "./ReplayCard";
import { RoomViewShell } from "./RoomViewShell";
import type { useGomokuSession } from "./useGomokuSession";
import type { useRoomChat } from "./useRoomChat";
export function GomokuRoomView({
  session,
  chat,
  invited,
}: {
  session: ReturnType<typeof useGomokuSession>;
  chat: ReturnType<typeof useRoomChat>;
  invited: boolean;
}) {
  const { room, membership, presence } = session;
  const [rotation, setRotation] = useState<QuarterTurn>(0);
  const displayRotation = membership ? 0 : rotation;
  const replay = useGomokuReplay(room.status === "waiting" ? room.lastRound : null);
  const anchor =
    room.players.find((p) => p.id === membership?.playerId) ??
    (room.status === "playing" ? room.players.find((p) => p.color === "black") : room.players[0]);
  const seats = [anchor ?? null, room.players.find((p) => p.id !== anchor?.id) ?? null];
  const board = (
    <ReversiBoardLayout>
      {seats.map((p, i) => (
        <GomokuPlayerCard
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
      <GomokuBoard
        label="五目並べの盤面"
        game={replay.frame?.game ?? session.displayGame}
        rotation={displayRotation}
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
      board={
        <>
          {board}
          {!session.toast.shared && <AppToastRegion queue={session.toast.queue} theme="gomoku" />}
        </>
      }
      replayCard={replay.frame ? <ReplayCard replay={replay} theme="gomoku" /> : null}
      result={room.lastRound ? <GomokuResult lastRound={room.lastRound} /> : null}
      selfEliminated={false}
      onRotate={() => setRotation((r) => (r === 0 ? 2 : 0))}
      operationNotice={`禁手ルール：${(replay.frame?.game.forbiddenRules ?? room.settings.forbiddenRules) ? "ON" : "OFF"}`}
      gameSettings={
        <GomokuForbiddenControl
          enabled={
            session.pendingSettingsCommand?.type === "room.gomoku-forbidden.set"
              ? session.pendingSettingsCommand.enabled
              : room.settings.forbiddenRules
          }
          disabled={!session.canManageSettings}
          onChange={session.handleForbiddenChange}
        />
      }
    />
  );
}
