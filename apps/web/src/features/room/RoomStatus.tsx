import { managedRoomPath, isMatchmakingRoom } from "../matchmaking/managedRoom";
import { gameCapacity, gameCatalog } from "@tetraboard/protocol/games";
import { ViewerControls } from "./ViewerControls";
import { RoomStatusCard } from "./RoomStatusCard";
import { AppButton } from "../../shared/ui/AppButton";
import { AppIcon } from "../../shared/ui/AppIcon";

import { useId, type ReactNode, type Ref } from "react";
import { playerName } from "./roomCommonPresentation";
import { useRoomMobile } from "./useRoomDesktop";
import type { SharedRoomSession } from "./useRoomTransport";
import { isFourShogiRoom, type Room } from "@tetraboard/protocol";

const waitingActionWidth =
  "[@media(max-width:767px)]:flex-1 [@media(max-width:767px)]:min-w-[68px] [@media(max-width:767px)]:max-w-28";

export function RoomStatus({
  session,
  turn,
  onResults,
  onResign,
  turnActions,
  stampPicker,
  onJoin,
  joinButtonRef,
  resultButtonRef,
  joinUnavailable,
  replay,
  openReplayKey,
  onReplayChange,
  onRotate,
  onTournamentNext,
  nextMatchPending = false,
}: {
  session: SharedRoomSession & { canPlay: boolean };
  turn: Room["players"][number] | undefined;
  onResults: () => void;
  onResign: () => void;
  turnActions?: ReactNode;
  stampPicker?: ReactNode;
  onJoin: () => void;
  joinButtonRef: Ref<HTMLButtonElement>;
  resultButtonRef?: Ref<HTMLButtonElement>;
  joinUnavailable: string | null;
  replay?: ReactNode;
  openReplayKey: string | null;
  onReplayChange: (key: string | null) => void;
  onRotate: () => void;
  onTournamentNext?: () => void;
  nextMatchPending?: boolean;
}) {
  const { room, self, membership, presence, authenticated, connection } = session;
  const waiting = room.status === "waiting";
  const mobile = useRoomMobile();
  const replayPanelId = useId();
  const round = room.lastRound;
  const mobileReplayKey =
    mobile && replay && round
      ? `${room.instanceId}:${"roundId" in round ? round.roundId : (round.replay?.id ?? "legacy")}`
      : null;
  const replayOpen = mobileReplayKey !== null && openReplayKey === mobileReplayKey;
  const managed = managedRoomPath(room) !== null;
  const nextTournamentRound =
    managed &&
    ((room.status === "waiting" && room.lastRound !== null) ||
      (room.status === "playing" &&
        self &&
        (isFourShogiRoom(room) && "side" in self
          ? room.game.eliminations.some((entry) => entry.side === self.side)
          : "color" in self &&
            self.color !== null &&
            "eliminatedColors" in room.game &&
            (room.game.eliminatedColors.some((color) => color === self.color) ||
              ("completedColors" in room.game &&
                room.game.completedColors.some((color) => color === self.color))))));
  const myTurn = turn !== undefined && turn.id === self?.id;
  const available =
    authenticated &&
    connection === "接続済み" &&
    !session.leaving &&
    session.pendingGameAction === null;
  const registering = room.players.some(
    (player) => player.kind === "human" && player.registrationPendingUntilMs !== undefined,
  );
  const ownRegistration = self?.kind === "human" && self.registrationPendingUntilMs !== undefined;
  const ready = available && session.pendingReady === null && !ownRegistration;
  const canStart =
    ready &&
    !registering &&
    room.players.length === gameCapacity(room.settings.game) &&
    room.players.every((player) => player.ready && presence.connectedPlayerIds.includes(player.id));
  const notice = registering
    ? "登録手続きの完了を待っています。"
    : managed
      ? room.lastRound
        ? isMatchmakingRoom(room)
          ? "マッチングの対局が終了しました。"
          : "大会の対局が終了しました。"
        : "参加者の接続を待っています。"
      : null;
  const status = (
    <RoomStatusCard
      className={`[@media(min-width:360px)]:[&>button:not(.button--icon-only)]:min-w-16 [@media(min-width:768px)]:[&>button:not(.button--icon-only)]:min-w-[84px] ${replayOpen ? "rounded-t-none" : ""}`}
    >
      <div
        role="status"
        className={
          !myTurn && turn
            ? "flex min-w-0 flex-1 items-center text-sm font-bold"
            : waiting && notice && !replay
              ? "min-w-0 truncate text-xs"
              : "sr-only"
        }
      >
        {waiting ? (
          (notice ?? "待機中です。")
        ) : myTurn ? (
          "あなたの番です。"
        ) : turn ? (
          <>
            <span className="truncate">{playerName(turn)}</span>
            <span className="shrink-0">の番です。</span>
          </>
        ) : null}
      </div>
      {!managed && waiting && self && membership && (
        <AppButton
          size="compact"
          className={waitingActionWidth}
          appearance={self.ready ? "secondary" : "primary"}
          isDisabled={!ready}
          isPending={session.pendingReady !== null}
          onPress={session.handleReadyClick}
        >
          {ownRegistration ? "登録手続中" : self.ready ? "準備取消" : "準備完了"}
        </AppButton>
      )}
      {!managed && waiting && membership?.role === "host" && (
        <AppButton
          size="compact"
          className={waitingActionWidth}
          isDisabled={!canStart}
          isPending={session.pendingGameAction?.type === "start"}
          onPress={session.handleStartClick}
        >
          対局開始
        </AppButton>
      )}
      {waiting && room.lastRound && (
        <AppButton ref={resultButtonRef} appearance="secondary" size="compact" onPress={onResults}>
          結果
        </AppButton>
      )}
      {mobileReplayKey ? (
        <AppButton
          appearance="secondary"
          size="compact"
          aria-expanded={replayOpen}
          aria-controls={replayPanelId}
          onPress={() => onReplayChange(replayOpen ? null : mobileReplayKey)}
        >
          棋譜
          <AppIcon name="chevronDown" className={`size-3 ${replayOpen ? "" : "rotate-180"}`} />
        </AppButton>
      ) : (
        replay && <div className="min-w-0 flex-1">{replay}</div>
      )}
      {membership === null && (managed || !joinUnavailable) && (
        <AppButton size="compact" ref={joinButtonRef} onPress={onJoin}>
          {managed ? (isMatchmakingRoom(room) ? "マッチングへ" : "大会へ") : "参加する"}
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
          isDisabled={session.leaving || nextMatchPending}
          isPending={session.leaving}
          onPress={onTournamentNext}
        >
          {isMatchmakingRoom(room) ? "もう一度マッチング" : "次の対局"}
        </AppButton>
      )}
      {turnActions}
      {stampPicker}
      {membership === null && (
        <ViewerControls
          label="観戦中"
          onRotate={onRotate}
          rotationDegrees={!gameCatalog[room.settings.game].hasModes ? 180 : 90}
        />
      )}
    </RoomStatusCard>
  );
  if (!mobileReplayKey) return status;

  return (
    <div className="col-start-1 row-start-2 flex min-w-0 flex-col">
      {status}
      <div id={replayPanelId} hidden={!replayOpen} className="order-first mx-[2px] min-w-0">
        {replayOpen && replay}
      </div>
    </div>
  );
}
