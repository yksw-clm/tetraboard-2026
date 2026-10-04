import { useBoardRotation } from "./useBoardRotation";
import { rotatedShogiViewer } from "./boardRotation";
import { sides, type Side } from "@tetraboard/four-shogi";
import type { ReactNode } from "react";
import { AppButton } from "../../shared/ui/AppButton";
import { FourShogiBoardLayout } from "./FourShogiBoardLayout";
import { FourShogiGameResultView } from "./FourShogiGameResultView";
import { FourShogiPlayerCard } from "./FourShogiPlayerCard";
import { ReplayCard } from "./ReplayCard";
import { RoomViewShell } from "./RoomViewShell";
import { shogiCardPosition, shogiRoomSeats, shogiViewerSide } from "./fourShogiRoomPresentation";
import { useFourShogiRoomReplay } from "./useFourShogiRoomReplay";
import type { useFourShogiRoomSession } from "./useFourShogiRoomSession";
import type { useRoomChat } from "./useRoomChat";

export function FourShogiRoomView({
  session,
  chat,
  invited,
}: {
  session: ReturnType<typeof useFourShogiRoomSession>;
  chat: ReturnType<typeof useRoomChat>;
  invited: boolean;
}) {
  const { room, membership, presence } = session;
  const { rotation, rotate } = useBoardRotation();
  const viewerRotation = membership === null ? rotation : 0;
  const replay = useFourShogiRoomReplay(room);
  const viewerSide = rotatedShogiViewer(
    shogiViewerSide(room, membership?.playerId),
    viewerRotation,
  );
  const seats = shogiRoomSeats(room, membership?.playerId);
  const playerCards = Object.fromEntries(
    sides.map((side) => {
      const player = seats[side];
      return [
        side,
        <FourShogiPlayerCard
          key={side}
          player={player}
          side={side}
          position={shogiCardPosition(side, viewerSide)}
          room={room}
          game={replay.frame?.game}
          self={!!player && player.id === membership?.playerId}
          host={!!player && player.id === presence.hostPlayerId}
          connected={!!player && presence.connectedPlayerIds.includes(player.id)}
          now={session.serverNowMs}
        />,
      ];
    }),
  ) as Record<Side, ReactNode>;
  const selfIsEliminated =
    room.status === "playing" &&
    room.game.eliminations.some((entry) => entry.side === session.self?.side);
  const promotionUnavailable =
    session.unavailable !== null || (!session.authenticated && session.socketError !== null);
  const board = (
    <>
      <FourShogiBoardLayout
        game={replay.frame?.game ?? session.displayGame}
        viewerSide={viewerSide}
        revision={`${room.roundId ?? room.lastRound?.roundId ?? "waiting"}:${room.positionRevision}:${replay.index}`}
        canPlay={session.canPlay && replay.frame === null}
        promotionContext={
          room.status === "playing" &&
          session.self?.side &&
          !selfIsEliminated &&
          !promotionUnavailable &&
          replay.frame === null
            ? {
                instanceId: room.instanceId,
                playerId: session.self.id,
                roundId: room.roundId,
                positionRevision: room.positionRevision,
                side: session.self.side,
                confirmed: session.authenticated && session.connection === "接続済み",
              }
            : undefined
        }
        legalActions={room.legalActions}
        threePlayerAttackForbiddenActions={room.threePlayerAttackForbiddenActions}
        onAction={session.handleShogiAction}
        playerCards={playerCards}
        checkState={replay.frame?.checkState ?? room.checkState}
      />
      {(replay.loading || replay.error) && (
        <div
          className="absolute bottom-1 inset-x-1 flex items-center justify-center gap-2 rounded-lg bg-white/95 px-2 py-1 text-xs"
          role={replay.error ? "alert" : "status"}
        >
          <span>{replay.error ?? "棋譜を読み込んでいます…"}</span>
          {replay.error && (
            <AppButton size="compact" appearance="secondary" onPress={replay.retry}>
              再試行
            </AppButton>
          )}
        </div>
      )}
    </>
  );
  return (
    <RoomViewShell
      session={session}
      onRotate={rotate}
      chat={chat}
      invited={invited}
      board={board}
      replayCard={replay.frame ? <ReplayCard replay={replay} theme="four-shogi" /> : null}
      result={room.lastRound && <FourShogiGameResultView lastRound={room.lastRound} />}
      selfEliminated={
        room.status === "playing" &&
        !!session.self?.side &&
        room.game.eliminations.some((entry) => entry.side === session.self?.side)
      }
    />
  );
}
