import { useRoomDesktop } from "./useRoomDesktop";
import { AppButton } from "../../shared/ui/AppButton";
import { Toast } from "@heroui/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { CpuLevel } from "@tetraboard/protocol";
import { AppButtonLink } from "../../shared/ui/AppButton";
import { fourReversiLobbyPath, fourShogiLobbyPath } from "../../app/paths";
import { useRoomInvitation } from "./useRoomInvitation";
import { RoomInvitationDialogs } from "./RoomInvitationDialogs";
import { RoomChat } from "./RoomChat";
import { RoomInfo } from "./RoomInfo";
import { RoomStatus } from "./RoomStatus";
import { AppDialog } from "../../shared/ui/AppDialog";
import { RoomLayout } from "./RoomLayout";
import type { useRoomChat } from "./useRoomChat";
import type { SharedRoomSession } from "./useRoomTransport";
import { appThemeClasses } from "../../shared/ui/appTheme";
import { useAccount } from "../account/useAccount";
import { CpuMatchNotice } from "../account/CpuMatchNotice";
import { RegistrationPrompt } from "../account/RegistrationPrompt";
import { useGoogleSignIn } from "../account/useGoogleSignIn";
import { useRegistrationResult } from "./useRegistrationResult";
import { roomInvitationPath } from "../../shared/roomAccess";
import { useFeedback, type FeedbackContext } from "../feedback/useFeedback";
import { FeedbackForm } from "../feedback/FeedbackForm";

export function RoomViewShell({
  session,
  chat,
  invited,
  board,
  replayCard,
  result,
  selfEliminated,
  onRotate,
  turnActions,
  gameSettings,
  operationNotice,
}: {
  session: SharedRoomSession & {
    canPlay: boolean;
    handleResignClick: () => void;
  };
  chat: ReturnType<typeof useRoomChat>;
  invited: boolean;
  board: ReactNode;
  replayCard: ReactNode;
  result: ReactNode;
  selfEliminated: boolean;
  onRotate: () => void;
  turnActions?: ReactNode;
  gameSettings?: ReactNode;
  operationNotice?: string | null;
}) {
  const desktop = useRoomDesktop();
  const account = useAccount();
  const google = useGoogleSignIn();
  const [tab, setTab] = useState("board");
  const [dialog, setDialog] = useState<"result" | "leave" | "resign" | "feedback" | null>(null);
  const [cpuConfirmation, setCpuConfirmation] = useState<CpuLevel | null>(null);
  const { room, membership } = session;
  const feedbackContext: FeedbackContext = {
    page: "room",
    game: room.settings.game,
    room: {
      id: room.id,
      instanceId: room.instanceId,
      roundId: "roundId" in room ? room.roundId : null,
    },
  };
  const feedback = useFeedback(feedbackContext, Boolean(account.user));
  const feedbackButtonRef = useRef<HTMLButtonElement>(null);
  const theme = room.settings.game === "four-shogi" ? "four-shogi" : "default";
  const lobbyPath = theme === "four-shogi" ? fourShogiLobbyPath : fourReversiLobbyPath;
  const joinButtonRef = useRef<HTMLButtonElement>(null);
  const resultButtonRef = useRef<HTMLButtonElement>(null);
  const fallbackFocusRef = useRef<HTMLElement>(null);
  const cpuAddButtonRef = useRef<HTMLButtonElement>(null);
  const previousCpuConfirmation = useRef(false);
  const canAddCpu =
    session.canManageSettings &&
    session.presence.hostPlayerId === membership?.playerId &&
    room.players.length < 4 &&
    !account.loading &&
    !account.error;
  useEffect(() => {
    const closed = previousCpuConfirmation.current && cpuConfirmation === null;
    previousCpuConfirmation.current = cpuConfirmation !== null;
    if (!closed) return;
    // Modalのフォーカス復帰を待ち、リサイズで元のボタンが消えた場合も戻します。
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        const button = cpuAddButtonRef.current;
        if (button && !button.disabled) button.focus();
        if (!button || document.activeElement !== button) fallbackFocusRef.current?.focus();
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [cpuConfirmation]);
  if (cpuConfirmation !== null && (!canAddCpu || !account.user)) setCpuConfirmation(null);
  const invitation = useRoomInvitation(room, membership, invited, () => {
    (joinButtonRef.current ?? fallbackFocusRef.current)?.focus();
  });
  const guest = !account.loading && !account.error && !account.user;
  const autoResult = useRegistrationResult(
    room,
    membership?.playerId,
    guest && session.authenticated && !session.leaving,
    dialog !== null || invitation.dialog !== null || cpuConfirmation !== null,
    Boolean(session.unavailable),
  );
  const closeResult = () => {
    autoResult.dismiss();
    setDialog(null);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        (resultButtonRef.current ?? fallbackFocusRef.current)?.focus();
      }),
    );
  };
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
      gameSettings={gameSettings}
      feedbackButtonRef={feedbackButtonRef}
      onFeedback={() => {
        autoResult.dismiss();
        setDialog("feedback");
      }}
      session={session}
      cpuAddButtonRef={cpuAddButtonRef}
      canAddCpu={canAddCpu}
      onAddCpu={(level) => {
        if (!canAddCpu) return;
        if (account.user && !room.players.some((player) => player.kind === "cpu")) {
          setCpuConfirmation(level);
        } else session.addCpu(level);
      }}
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
      onRotate={onRotate}
      replay={desktop ? undefined : replayCard}
      onJoin={invitation.openJoin}
      joinButtonRef={joinButtonRef}
      resultButtonRef={resultButtonRef}
      joinUnavailable={invitation.unavailableReason}
      onResults={() => {
        autoResult.dismiss();
        setDialog("result");
      }}
      onResign={() => setDialog("resign")}
      turnActions={turnActions}
    />
  );
  const chatPanel = (
    <RoomChat chat={chat} session={session} visible={desktop || tab === "chat"} theme={theme} />
  );
  const connectionNotice = session.connection !== "接続済み" ? session.connection : null;
  const pendingNotice = !connectionNotice && !session.socketError ? operationNotice : null;

  return (
    <main
      className={`app-theme ${appThemeClasses[theme]} room-background relative flex flex-col h-dvh overflow-hidden text-ink text-sm leading-normal`}
      ref={fallbackFocusRef}
      tabIndex={-1}
    >
      {(connectionNotice || session.socketError || pendingNotice) && (
        <div
          className="absolute top-[calc(env(safe-area-inset-top)_+_8px)] left-1/2 -translate-x-1/2 z-10 pointer-events-none w-max max-w-[min(480px,calc(100%_-_16px))] rounded-lg py-[7px] px-4 bg-[#fff4dc] text-[#755b21] text-xs text-center break-words"
          role="status"
        >
          {connectionNotice}
          {connectionNotice && session.socketError ? " — " : ""}
          {session.socketError}
          {pendingNotice}
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
      <RoomInvitationDialogs
        invitation={invitation}
        roomId={room.id}
        theme={theme}
        registrationPath={roomInvitationPath(room)}
        humanOnly={!room.players.some((p) => p.kind === "cpu")}
      />
      {cpuConfirmation !== null && (
        <AppDialog
          size="compact"
          title="CPUを追加しますか？"
          onClose={() => setCpuConfirmation(null)}
          theme={theme}
        >
          <p className="mb-3 text-sm">追加するCPU：Lv{cpuConfirmation}</p>
          <CpuMatchNotice />
          <div className="mt-[22px] flex justify-end gap-[10px]">
            <AppButton
              size="compact"
              appearance="secondary"
              onPress={() => setCpuConfirmation(null)}
            >
              キャンセル
            </AppButton>
            <AppButton
              size="compact"
              isDisabled={!canAddCpu}
              onPress={() => {
                if (!canAddCpu) return;
                session.addCpu(cpuConfirmation);
                setCpuConfirmation(null);
              }}
            >
              CPUを追加
            </AppButton>
          </div>
        </AppDialog>
      )}
      {(dialog === "result" || autoResult.visible) && room.lastRound && (
        <AppDialog
          size="compact"
          title="対局結果"
          onClose={closeResult}
          theme={theme}
          busy={google.busy}
        >
          {result}
          {guest && (
            <div className="mt-5">
              <RegistrationPrompt
                result
                seated={membership !== null}
                humanOnly={room.lastRound.players.every((p) =>
                  room.players.some((current) => current.id === p.id && current.kind === "human"),
                )}
                busy={google.busy}
                onRegister={() => void google.start({ path: roomInvitationPath(room) })}
                onDismiss={closeResult}
              />
              {google.message && (
                <p role="alert" className="mt-3 text-sm text-danger">
                  {google.message}
                </p>
              )}
            </div>
          )}
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
      {dialog === "feedback" && (
        <AppDialog
          title="不具合・ご意見"
          theme={theme}
          busy={feedback.busy}
          onClose={() => {
            if (feedback.busy) return;
            setDialog(null);
            requestAnimationFrame(() =>
              requestAnimationFrame(() =>
                (feedbackButtonRef.current ?? fallbackFocusRef.current)?.focus(),
              ),
            );
          }}
        >
          <FeedbackForm feedback={feedback} context={feedbackContext} />
        </AppDialog>
      )}
    </main>
  );
}
