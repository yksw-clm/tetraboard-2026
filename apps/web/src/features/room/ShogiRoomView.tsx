import { useBoardRotation } from "./useBoardRotation";
import { otherSide, canProposeImpasse } from "@tetraboard/shogi";
import { useState } from "react";
import { AppDialog } from "../../shared/ui/AppDialog";
import { sides, type Side } from "@tetraboard/shogi";
import type { ReactNode } from "react";
import { AppButton } from "../../shared/ui/AppButton";
import { FourShogiBoardLayout as ShogiBoardLayout } from "./FourShogiBoardLayout";
import { ShogiResult } from "./ShogiResult";
import { ShogiPlayerCard } from "./ShogiPlayerCard";
import { ReplayCard } from "./ReplayCard";
import { RoomViewShell } from "./RoomViewShell";
import { shogiRoomSeats, shogiViewerSide } from "./standardShogiRoomPresentation";
import { useShogiRoomReplay } from "./useShogiRoomReplay";
import type { useShogiRoomSession } from "./useShogiRoomSession";
import type { useRoomChat } from "./useRoomChat";

export function ShogiRoomView({
  session,
  chat,
  invited,
}: {
  session: ReturnType<typeof useShogiRoomSession>;
  chat: ReturnType<typeof useRoomChat>;
  invited: boolean;
}) {
  const { room, membership, presence } = session;
  const { rotation, rotate } = useBoardRotation();
  const [declaration, setDeclaration] = useState<{
    roundId: string;
    positionRevision: number;
  } | null>(null);
  const replay = useShogiRoomReplay(room);
  const baseSide = shogiViewerSide(room, membership?.playerId);
  const viewerSide = membership === null && rotation % 2 ? otherSide(baseSide) : baseSide;
  const seats = shogiRoomSeats(room, membership?.playerId);
  const playerCards = Object.fromEntries(
    sides.map((side) => {
      const player = seats[side];
      return [
        side,
        <ShogiPlayerCard
          key={side}
          player={player}
          side={side}
          position={side === viewerSide ? "bottom" : "top"}
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
      <ShogiBoardLayout
        standard
        game={replay.frame?.game ?? session.displayGame}
        pendingAction={replay.frame === null ? session.pendingMove?.action : undefined}
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
            <AppButton
              size="compact"
              appearance="secondary"
              isDisabled={replay.loading}
              isPending={replay.retrying}
              onPress={replay.retry}
            >
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
      operationNotice={session.moveNotice}
      turnActions={
        <>
          {room.status === "playing" && session.self?.side && canProposeImpasse(room.game) && (
            <AppButton
              size="compact"
              appearance="secondary"
              isDisabled={!session.canAct}
              isPending={session.pendingGameAction?.type === "draw"}
              onPress={session.handleDrawProposalClick}
            >
              {room.game.drawProposals.includes(session.self.side)
                ? "持将棋取消"
                : room.game.drawProposals.length
                  ? "持将棋同意"
                  : "持将棋提案"}
            </AppButton>
          )}
          {room.status === "playing" &&
            session.self?.side === room.game.turn &&
            room.game.moveNumber < 500 && (
              <AppButton
                size="compact"
                appearance="secondary"
                isDisabled={!session.canPlay}
                onPress={() =>
                  setDeclaration({ roundId: room.roundId, positionRevision: room.positionRevision })
                }
              >
                入玉宣言
              </AppButton>
            )}
          {declaration &&
            room.status === "playing" &&
            declaration.roundId === room.roundId &&
            declaration.positionRevision === room.positionRevision &&
            session.self?.side === room.game.turn && (
              <AppDialog
                size="compact"
                title="入玉を宣言しますか？"
                theme="shogi"
                onClose={() => setDeclaration(null)}
              >
                <p>
                  敵陣に玉と玉以外の駒10枚以上があり、王手がかかっていないことが条件です。敵陣の駒と持ち駒の合計が31点以上なら勝利、24〜30点なら引き分けです。条件を満たさない宣言は敗北になります。
                </p>
                <div className="mt-4 flex justify-end gap-2">
                  <AppButton
                    size="compact"
                    appearance="secondary"
                    onPress={() => setDeclaration(null)}
                  >
                    キャンセル
                  </AppButton>
                  <AppButton
                    size="compact"
                    isDisabled={!session.canPlay}
                    onPress={() => {
                      session.handleDeclaration();
                      setDeclaration(null);
                    }}
                  >
                    宣言する
                  </AppButton>
                </div>
              </AppDialog>
            )}
        </>
      }
      onRotate={rotate}
      chat={chat}
      invited={invited}
      board={board}
      replayCard={replay.frame ? <ReplayCard replay={replay} theme="shogi" /> : null}
      result={room.lastRound && <ShogiResult lastRound={room.lastRound} />}
      selfEliminated={
        room.status === "playing" &&
        !!session.self?.side &&
        room.game.eliminations.some((entry) => entry.side === session.self?.side)
      }
    />
  );
}
