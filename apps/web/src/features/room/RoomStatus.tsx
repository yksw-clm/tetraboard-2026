import { gameCatalog } from "@tetraboard/protocol/games";
import { gameCapacity } from "@tetraboard/protocol/games";
import { ViewerControls } from "./ViewerControls";
import { RoomClock } from "./RoomClock";
import { AppCard } from "../../shared/ui/AppCard";
import { AppButton } from "../../shared/ui/AppButton";

import type { ReactNode, Ref } from "react";
import { playerName } from "./roomCommonPresentation";
import { playerClock, shogiPlayerClock, reversiPlayerClock } from "./playerClocks";
import type { SharedRoomSession } from "./useRoomTransport";
import {
  isFourShogiRoom,
  isShogiRoom,
  isFourReversiRoom,
  isFourGomokuRoom,
  isReversiRoom,
} from "@tetraboard/protocol";

export function RoomStatus({
  session,
  onResults,
  onResign,
  turnActions,
  stampPicker,
  onJoin,
  joinButtonRef,
  resultButtonRef,
  joinUnavailable,
  replay,
  onRotate,
  onTournamentNext,
}: {
  session: SharedRoomSession & { canPlay: boolean };
  onResults: () => void;
  onResign: () => void;
  turnActions?: ReactNode;
  stampPicker?: ReactNode;
  onJoin: () => void;
  joinButtonRef: Ref<HTMLButtonElement>;
  resultButtonRef?: Ref<HTMLButtonElement>;
  joinUnavailable: string | null;
  replay?: ReactNode;
  onRotate: () => void;
  onTournamentNext?: () => void;
}) {
  const { room, self, membership, presence, authenticated, connection } = session;
  const waiting = room.status === "waiting";
  const tournamentId = isFourShogiRoom(room) ? room.tournamentId : undefined;
  const nextTournamentRound =
    tournamentId !== undefined &&
    isFourShogiRoom(room) &&
    ((room.status === "waiting" && room.lastRound !== null) ||
      (room.status === "playing" &&
        self &&
        "side" in self &&
        room.game.eliminations.some((entry) => entry.side === self.side)));
  const turn =
    room.status === "playing"
      ? isFourShogiRoom(room) || isShogiRoom(room)
        ? room.players.find((player) => player.side === room.game.turn)
        : room.players.find((player) => player.color === room.game.turn)
      : null;
  const myTurn = !!turn && turn.id === self?.id;
  const clock = turn
    ? (isFourShogiRoom(room) || isShogiRoom(room)) && "side" in turn
      ? shogiPlayerClock(room, turn.side, session.serverNowMs)
      : (isFourReversiRoom(room) || isFourGomokuRoom(room)) && "color" in turn
        ? playerClock(room, turn.color, session.serverNowMs)
        : isReversiRoom(room) &&
            "color" in turn &&
            (turn.color === "black" || turn.color === "white")
          ? reversiPlayerClock(room, turn.color, session.serverNowMs)
          : null
    : null;
  const available =
    authenticated &&
    connection === "接続済み" &&
    !session.leaving &&
    session.pendingGameAction === null;
  const registering = room.players.filter(
    (player) => player.kind === "human" && player.registrationPendingUntilMs !== undefined,
  );
  const ownRegistration = self?.kind === "human" && self.registrationPendingUntilMs !== undefined;
  const ready = available && session.pendingReady === null && !ownRegistration;
  const canStart =
    ready &&
    registering.length === 0 &&
    room.players.length === gameCapacity(room.settings.game) &&
    room.players.every((player) => player.ready && presence.connectedPlayerIds.includes(player.id));
  return (
    <AppCard
      density="compact"
      className={`min-h-[88px] flex flex-col justify-center gap-2 shrink-0 [@media(min-width:1280px)]:col-start-2 [@media(min-width:1280px)]:row-start-2 [@media(max-width:1279px)]:col-start-1 [@media(max-width:1279px)]:row-start-2 [@media(min-width:768px)_and_(max-width:1279px)]:min-h-20 [@media(min-width:768px)_and_(max-width:1279px)]:grid [@media(min-width:768px)_and_(max-width:1279px)]:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] [@media(min-width:768px)_and_(max-width:1279px)]:items-center [@media(max-width:767px)]:mx-[2px] [@media(max-width:767px)]:py-2 [@media(max-width:767px)]:px-3 [@media(max-width:767px)]:h-[92px] [@media(max-width:767px)]:min-h-[92px] ${replay || membership === null ? "flex! flex-col!" : ""}`}
      aria-label="対局状況"
    >
      <div
        className={`flex justify-between items-center gap-[10px] min-h-6 [&>strong]:text-[15px] [&>strong]:leading-[1.45] [&>strong]:wrap-anywhere [@media(min-width:768px)_and_(max-width:1279px)]:contents [@media(min-width:768px)_and_(max-width:1279px)]:[&>strong]:col-start-1 [@media(min-width:768px)_and_(max-width:1279px)]:[&>strong]:row-start-1 [@media(max-width:767px)]:h-7 [@media(max-width:767px)]:min-h-7 [@media(max-width:767px)]:shrink-0 [@media(max-width:767px)]:[&>strong]:text-[clamp(12px,3.6vw,14px)] [@media(max-width:767px)]:[&>strong]:leading-[1.15] ${replay ? "grid! w-full grid-cols-[auto_minmax(0,1fr)_auto] gap-2 [&>*]:row-start-1 [&>strong]:whitespace-nowrap [@media(max-width:767px)]:gap-1" : membership === null ? "flex! w-full" : ""}`}
      >
        <strong
          className={
            myTurn ? "text-[#ca771d] animate-[room-urgency_1.5s_ease-in-out_infinite]" : undefined
          }
          aria-live="polite"
        >
          {waiting
            ? registering.length > 0
              ? "登録手続きの完了を待っています。"
              : tournamentId !== undefined
                ? room.lastRound
                  ? "大会の対局が終了しました。"
                  : "参加者の接続を待っています。"
                : "待機中です。"
            : myTurn
              ? "あなたの番です。"
              : `${turn ? playerName(turn) : ""}の番です。`}
        </strong>
        {replay}
        <div className="text-muted text-xs whitespace-nowrap [&>span]:text-xs [@media(min-width:768px)_and_(max-width:1279px)]:col-start-3 [@media(min-width:768px)_and_(max-width:1279px)]:row-start-1 [@media(min-width:768px)_and_(max-width:1279px)]:text-right">
          {waiting ? (
            room.lastRound ? (
              <AppButton
                ref={resultButtonRef}
                appearance="quiet"
                size="compact"
                className="text-brand bg-surface-muted rounded-lg h-7 min-h-7 text-xs py-[3px] px-[15px] [@media(max-width:767px)]:px-[6px] [@media(max-width:767px)]:min-w-9"
                onPress={onResults}
              >
                結果
              </AppButton>
            ) : (
              `参加者 ${room.players.length}/${gameCapacity(room.settings.game)}`
            )
          ) : (
            clock && <RoomClock clock={clock} describe className="text-xs" />
          )}
        </div>
      </div>
      <div
        className={`flex gap-2 min-h-[38px] [&>button]:flex-1 ${stampPicker ? "[&>button]:min-w-0 [&>button]:shrink [&>button]:px-2 [@media(max-width:767px)]:gap-1 [@media(max-width:767px)]:[&>button]:px-1" : ""} [@media(min-width:768px)_and_(max-width:1279px)]:col-start-2 [@media(min-width:768px)_and_(max-width:1279px)]:row-start-1 [@media(min-width:768px)_and_(max-width:1279px)]:min-w-[140px] [@media(max-width:767px)]:h-[38px] [@media(max-width:767px)]:min-h-[38px] [@media(max-width:767px)]:shrink-0`}
      >
        {membership === null && (
          <ViewerControls
            label="観戦中"
            onRotate={onRotate}
            rotationDegrees={!gameCatalog[room.settings.game].hasModes ? 180 : 90}
          >
            {(tournamentId !== undefined || !joinUnavailable) && (
              <AppButton size="compact" ref={joinButtonRef} onPress={onJoin}>
                {tournamentId !== undefined ? "大会へ" : "参加する"}
              </AppButton>
            )}
          </ViewerControls>
        )}
        {tournamentId === undefined && waiting && self && membership && (
          <AppButton
            size="compact"
            appearance={self.ready ? "secondary" : "primary"}
            isDisabled={!ready}
            isPending={session.pendingReady !== null}
            onPress={session.handleReadyClick}
          >
            {ownRegistration ? "登録手続中" : self.ready ? "準備取消" : "準備完了"}
          </AppButton>
        )}
        {tournamentId === undefined && waiting && membership?.role === "host" && (
          <AppButton
            size="compact"
            isDisabled={!canStart}
            isPending={session.pendingGameAction?.type === "start"}
            onPress={session.handleStartClick}
          >
            対局開始
          </AppButton>
        )}
        {myTurn && (
          <AppButton
            size="compact"
            isDisabled={!session.canPlay}
            onPress={onResign}
            appearance="danger"
          >
            投了
          </AppButton>
        )}
        {nextTournamentRound && membership && onTournamentNext && (
          <AppButton
            size="compact"
            isDisabled={session.leaving}
            isPending={session.leaving}
            onPress={onTournamentNext}
          >
            次の対局
          </AppButton>
        )}
        {turnActions}
        {stampPicker}
      </div>
    </AppCard>
  );
}
