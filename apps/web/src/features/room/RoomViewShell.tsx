import { useRoomDesktop } from "./useRoomDesktop";
import { AppButton } from "../../shared/ui/AppButton";
import { Toast } from "@heroui/react";
import { useRef, useState, type ReactNode } from "react";
import { AppButtonLink } from "../../shared/ui/AppButton";
import { fourReversiLobbyPath, fourShogiLobbyPath } from "../../app/paths";
import { useRoomInvitation } from "./useRoomInvitation";
import { RoomInvitationDialogs } from "./RoomInvitationDialogs";
import { RoomChat } from "./RoomChat";
import { RoomInfo } from "./RoomInfo";
import { RoomStatus } from "./RoomStatus";
import { AppDialog } from "../../shared/ui/AppDialog";
import { RoomLayout } from "./RoomLayout";
import { type useRoomChat } from "./useRoomChat";
import { type useRoomTransport } from "./useRoomTransport";
import { appThemeClasses } from "../../shared/ui/appTheme";

export function RoomViewShell({
  session,
  chat,
  invited,
  board,
  replayCard,
  result,
  selfEliminated,
}: {
  session: ReturnType<typeof useRoomTransport> & {
    canPlay: boolean;
    handleResignClick: () => void;
  };
  chat: ReturnType<typeof useRoomChat>;
  invited: boolean;
  board: ReactNode;
  replayCard: ReactNode;
  result: ReactNode;
  selfEliminated: boolean;
}) {
  const desktop = useRoomDesktop();
  const [tab, setTab] = useState("board");
  const [dialog, setDialog] = useState<"result" | "leave" | "resign" | null>(null);
  const { room, membership } = session;
  const theme = room.settings.game === "four-shogi" ? "four-shogi" : "default";
  const lobbyPath = theme === "four-shogi" ? fourShogiLobbyPath : fourReversiLobbyPath;
  const joinButtonRef = useRef<HTMLButtonElement>(null);
  const fallbackFocusRef = useRef<HTMLElement>(null);
  const invitation = useRoomInvitation(room, membership, invited, () => {
    (joinButtonRef.current ?? fallbackFocusRef.current)?.focus();
  });
  const busy = session.leaving || session.pendingGameAction?.type === "resign";
  if (
    (room.status !== "playing" && dialog === "resign") ||
    (room.status === "playing" && dialog === "result") ||
    (dialog === "resign" && selfEliminated)
  ) {
    setDialog(null);
  }

  if (session.unavailable)
    return (
      <main
        className={`app-theme ${appThemeClasses[theme]} room-background flex flex-col h-dvh overflow-hidden text-ink text-sm leading-normal items-center justify-center gap-4 p-6`}
      >
        <p role="alert">{session.unavailable}</p>
        <AppButtonLink size="compact" to={lobbyPath}>
          ロビーへ戻る
        </AppButtonLink>
      </main>
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
  const chatPanel = (
    <RoomChat chat={chat} session={session} visible={desktop || tab === "chat"} theme={theme} />
  );
  const connectionNotice = session.connection !== "接続済み" ? session.connection : null;

  return (
    <main
      className={`app-theme ${appThemeClasses[theme]} room-background flex flex-col h-dvh overflow-hidden text-ink text-sm leading-normal`}
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
        className={`app-theme ${appThemeClasses[theme]} z-[110000] [&_.toast]:border [&_.toast]:border-solid [&_.toast]:border-line [&_.toast]:bg-white [&_.toast]:rounded-[14px] [&_.toast]:shadow-[0_5px_28px_#193d2926]`}
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
      <RoomInvitationDialogs invitation={invitation} roomId={room.id} theme={theme} />
      {dialog === "result" && room.lastRound && (
        <AppDialog size="compact" title="対局結果" onClose={() => setDialog(null)} theme={theme}>
          {result}
        </AppDialog>
      )}
      {(dialog === "leave" || dialog === "resign") && (
        <AppDialog
          size="compact"
          title={dialog === "leave" ? "ルームから退室しますか？" : "投了しますか？"}
          busy={busy}
          theme={theme}
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
