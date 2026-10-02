import { useRoomDesktop } from "./useRoomDesktop";
import { AppButton } from "../../shared/ui/AppButton";
import { Toast } from "@heroui/react";
import { useRef, useState } from "react";
import { AppButtonLink } from "../../shared/ui/AppButton";
import { fourReversiLobbyPath } from "../../app/paths";
import { useRoomInvitation } from "./useRoomInvitation";
import { RoomInvitationDialogs } from "./RoomInvitationDialogs";
import { FourReversiBoard } from "./FourReversiBoard";
import { GameResultView } from "./GameResultView";
import { RoomChat } from "./RoomChat";
import { RoomInfo } from "./RoomInfo";
import { RoomStatus } from "./RoomStatus";
import { AppDialog } from "../../shared/ui/AppDialog";
import { RoomBoardLayout, RoomLayout } from "./RoomLayout";
import { PlayerCard } from "./PlayerCard";
import { ReplayCard } from "./ReplayCard";
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
  const desktop = useRoomDesktop();
  const [tab, setTab] = useState("board");
  const [dialog, setDialog] = useState<"result" | "leave" | "resign" | null>(null);
  const { room, membership, presence } = session;
  const replay = useRoomReplay(room);
  const replayCard = replay.frame ? <ReplayCard replay={replay} /> : null;
  const joinButtonRef = useRef<HTMLButtonElement>(null);
  const fallbackFocusRef = useRef<HTMLElement>(null);
  const invitation = useRoomInvitation(room, membership, invited, () => {
    (joinButtonRef.current ?? fallbackFocusRef.current)?.focus();
  });
  const busy = session.leaving || session.pendingGameAction?.type === "resign";
  if (
    (room.status !== "playing" && dialog === "resign") ||
    (room.status === "playing" && dialog === "result") ||
    (dialog === "resign" &&
      session.self?.color &&
      room.status === "playing" &&
      room.game.eliminatedColors.includes(session.self.color))
  ) {
    setDialog(null);
  }

  if (session.unavailable)
    return (
      <main className="app-theme room-background flex flex-col h-dvh overflow-hidden text-ink text-sm leading-normal items-center justify-center gap-4 p-6">
        <p role="alert">{session.unavailable}</p>
        <AppButtonLink size="compact" to={fourReversiLobbyPath}>
          ロビーへ戻る
        </AppButtonLink>
      </main>
    );

  const board = (
    <RoomBoardLayout>
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
  const info = (
    <RoomInfo
      session={session}
      onCopyInvite={() =>
        void invitation.copy(() =>
          chat.toastQueue.add(
            {
              title: "招待リンクをコピーしました",
              description: "友達にリンクを送って招待できます。",
            },
            { timeout: 3000 },
          ),
        )
      }
      onLeave={() => {
        if (room.status === "playing") setDialog("leave");
        else void session.handleLeaveClick();
      }}
    />
  );
  const status = (
    <RoomStatus
      session={session}
      replay={desktop ? undefined : replayCard}
      onJoin={invitation.openJoin}
      joinButtonRef={joinButtonRef}
      joinUnavailable={invitation.unavailableReason}
      onResults={() => setDialog("result")}
      onResign={() => setDialog("resign")}
    />
  );
  const chatPanel = <RoomChat chat={chat} session={session} visible={desktop || tab === "chat"} />;
  const connectionNotice = session.connection !== "接続済み" ? session.connection : null;

  return (
    <main
      className="app-theme room-background flex flex-col h-dvh overflow-hidden text-ink text-sm leading-normal"
      ref={fallbackFocusRef}
      tabIndex={-1}
    >
      {(connectionNotice || session.socketError) && (
        <div
          className="shrink-0 py-[7px] px-4 bg-[#fff4dc] text-[#755b21] text-xs text-center"
          role="status"
        >
          {connectionNotice}
          {connectionNotice && session.socketError ? " — " : ""}
          {session.socketError}
        </div>
      )}
      <RoomLayout
        desktop={desktop}
        tab={tab}
        onTabChange={setTab}
        board={board}
        info={info}
        status={status}
        chat={chatPanel}
        replay={replayCard}
      />
      <Toast.Provider
        queue={chat.toastQueue}
        placement="top"
        width="min(380px, calc(100vw - 24px))"
        className="app-theme z-[110000] [&_.toast]:border [&_.toast]:border-solid [&_.toast]:border-line [&_.toast]:bg-white [&_.toast]:rounded-[14px] [&_.toast]:shadow-[0_5px_28px_#193d2926]"
      >
        {({ toast }) => (
          <Toast toast={toast}>
            <Toast.Content>
              <Toast.Title>{toast.content.title}</Toast.Title>
              <Toast.Description className="wrap-anywhere whitespace-pre-wrap">
                {toast.content.description}
              </Toast.Description>
            </Toast.Content>
            <Toast.CloseButton aria-label="通知を閉じる" />
          </Toast>
        )}
      </Toast.Provider>
      <RoomInvitationDialogs invitation={invitation} roomId={room.id} />
      {dialog === "result" && room.lastRound && (
        <AppDialog size="compact" title="対局結果" onClose={() => setDialog(null)}>
          <GameResultView lastRound={room.lastRound} />
        </AppDialog>
      )}
      {(dialog === "leave" || dialog === "resign") && (
        <AppDialog
          size="compact"
          title={dialog === "leave" ? "ルームから退室しますか？" : "投了しますか？"}
          busy={busy}
          onClose={() => setDialog(null)}
        >
          <p>
            {dialog === "leave"
              ? "対局中に退室すると脱落になります。"
              : "投了すると脱落になります。"}
          </p>
          {session.socketError && (
            <p className="text-danger text-xs" role="alert">
              {session.socketError}
            </p>
          )}
          <div className="flex justify-end gap-[10px] mt-[22px]">
            <AppButton
              size="compact"
              isDisabled={busy}
              appearance="secondary"
              onPress={() => setDialog(null)}
            >
              キャンセル
            </AppButton>
            <AppButton
              size="compact"
              isDisabled={busy || (dialog === "resign" && !session.canPlay)}
              appearance="danger"
              onPress={() => {
                if (dialog === "leave") void session.handleLeaveClick();
                else session.handleResignClick();
              }}
            >
              {busy ? "送信中…" : dialog === "leave" ? "退室する" : "投了する"}
            </AppButton>
          </div>
        </AppDialog>
      )}
    </main>
  );
}
