import { RoomStampContext } from "./roomStampContext";
import { useRoomStamps } from "./useRoomStamps";
import { RoomStampPicker } from "./RoomStampPicker";
import { useRoomDesktop } from "./useRoomDesktop";
import { AppPageState } from "../../shared/ui/AppPageState";
import { AppButton } from "../../shared/ui/AppButton";
import { AppToastRegion } from "../../shared/ui/AppToastRegion";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import { useCpuAddition } from "./useCpuAddition";
import { AppButtonLink } from "../../shared/ui/AppButton";
import { useRoomInvitation } from "./useRoomInvitation";
import { RoomInvitationDialogs } from "./RoomInvitationDialogs";
import { RoomChat } from "./RoomChat";
import { RoomInfo } from "./RoomInfo";
import { RoomStatus } from "./RoomStatus";
import { AppDialog } from "../../shared/ui/AppDialog";
import { RoomLayout } from "./RoomLayout";
import type { useRoomChat } from "./useRoomChat";
import type { SharedRoomSession } from "./useRoomTransport";
import { gameCatalog } from "@tetraboard/protocol/games";
import { gameThemes, appThemeClasses } from "../../shared/ui/appTheme";
import { useAccount } from "../account/useAccount";
import { CpuMatchNotice } from "../account/CpuMatchNotice";
import { RegistrationPrompt } from "../account/RegistrationPrompt";
import { useResultRegistration } from "../account/useResultRegistration";
import {
  registrationMatchId,
  readGuestRegistration,
  clearGuestRegistration,
} from "../account/guestRegistration";
import { clearRegistrationReturn } from "../account/registrationReturn";
import { readRoomMembershipToken } from "../../shared/roomMembership";
import { useAutoGameResult } from "./useAutoGameResult";
import { useFeedback, type FeedbackContext } from "../feedback/useFeedback";
import { FeedbackForm } from "../feedback/FeedbackForm";
import { RoomShareDialog } from "./RoomShareDialog";

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
  const signIn = useResultRegistration(session.room);
  const location = useLocation();
  const navigate = useNavigate();
  const [unfinishedRegistration, setUnfinishedRegistration] = useState(readGuestRegistration);
  const [registrationResult] = useState(() => {
    const result =
      (location.state as { registrationResult?: { matchId: string; record: string } } | null)
        ?.registrationResult ??
      (unfinishedRegistration?.returning && {
        matchId: unfinishedRegistration.matchId,
        record: unfinishedRegistration.returning.record,
      });
    return result?.matchId === registrationMatchId(session.room) ? result : null;
  });
  const [registrationCancelled] = useState(
    () =>
      (location.state as { registrationCancelledMatchId?: string } | null)
        ?.registrationCancelledMatchId === registrationMatchId(session.room),
  );
  const [tab, setTab] = useState("board");
  const [dialog, setDialog] = useState<
    "result" | "leave" | "resign" | "feedback" | "settings" | null
  >(registrationResult || registrationCancelled ? "result" : null);
  const { room, membership } = session;
  useEffect(() => {
    if (
      !unfinishedRegistration?.returning ||
      !session.authenticated ||
      !membership?.accountLinked ||
      room.instanceId !== unfinishedRegistration.instanceId ||
      membership.playerId !== unfinishedRegistration.returning.playerId ||
      readRoomMembershipToken(room.id) !== unfinishedRegistration.newToken
    )
      return;
    clearGuestRegistration(unfinishedRegistration);
    clearRegistrationReturn();
    // WebSocketが新しい資格で同じ席への復帰を確認した時点で情報を消費します。
    // eslint-disable-next-line react/set-state-in-effect
    setUnfinishedRegistration(null);
  }, [unfinishedRegistration, session.authenticated, membership, room.instanceId, room.id]);
  const [registrationNow, setRegistrationNow] = useState(Date.now);
  const registering = room.players.filter(
    (player) => player.kind === "human" && player.registrationPendingUntilMs !== undefined,
  );
  const registrationCount = registering.length;
  useEffect(() => {
    if (registrationCount === 0) return;
    const timer = setInterval(() => setRegistrationNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [registrationCount]);
  const registrationNotice =
    registering.length > 0
      ? registering
          .map((player) => {
            const deadline = player.kind === "human" ? player.registrationPendingUntilMs! : 0;
            const seconds = Math.max(
              0,
              Math.ceil((deadline - Math.max(registrationNow, session.serverNowMs)) / 1000),
            );
            return `${player.name}さんが登録手続中です（残り${Math.floor(seconds / 60)}分${seconds % 60}秒）`;
          })
          .join("。")
      : null;
  useEffect(() => {
    if ((registrationResult || registrationCancelled) && location.state)
      void navigate(location.pathname + location.search, { replace: true, state: null });
  }, [
    registrationResult,
    registrationCancelled,
    location.state,
    location.pathname,
    location.search,
    navigate,
  ]);
  const stamps = useRoomStamps(session, chat.hiddenSenders);
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
  const theme = gameThemes[room.settings.game];
  const lobbyPath = gameCatalog[room.settings.game].lobbyPath;
  const joinButtonRef = useRef<HTMLButtonElement>(null);
  const shareButtonRef = useRef<HTMLButtonElement>(null);
  const resultButtonRef = useRef<HTMLButtonElement>(null);
  const fallbackFocusRef = useRef<HTMLElement>(null);
  const cpuAddButtonRef = useRef<HTMLButtonElement>(null);
  const previousCpuConfirmation = useRef(false);
  const cpuAddition = useCpuAddition({
    room,
    membership,
    hostPlayerId: session.presence.hostPlayerId,
    canManageSettings: session.canManageSettings,
    account,
    addCpu: session.addCpu,
  });
  const canAddCpu = cpuAddition.canAdd;
  const cpuConfirmation = cpuAddition.confirmation;
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
  const invitation = useRoomInvitation(
    room,
    membership,
    invited,
    () => (joinButtonRef.current ?? fallbackFocusRef.current)?.focus(),
    () => {
      const button = shareButtonRef.current;
      button?.focus();
      // 自動表示を閉じたとき、非表示のルームタブへ焦点を移さず画面本体へ戻します。
      if (!button || document.activeElement !== button) fallbackFocusRef.current?.focus();
    },
  );
  const onCopied = () =>
    chat.toastQueue.add(
      {
        title: "ルームURLをコピーしました",
        description: "友達にリンクを送って招待できます。",
        theme,
      },
      { timeout: 3000 },
    );
  const accountAvailable = !account.loading && !account.error;
  const autoResult = useAutoGameResult(
    room,
    dialog !== null || invitation.dialog !== null || cpuConfirmation !== null,
    Boolean(session.unavailable) || session.leaving,
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
      <AppPageState theme={theme}>
        <p role="alert">{session.unavailable}</p>
        {unfinishedRegistration && (
          <AppButtonLink to="/account">登録の引継ぎを確認する</AppButtonLink>
        )}
        <AppButtonLink size="compact" to={lobbyPath}>
          ロビーへ戻る
        </AppButtonLink>
      </AppPageState>
    );

  const info = (
    <RoomInfo
      settingsOpen={dialog === "settings"}
      settingsDisabled={
        (dialog !== null && dialog !== "settings") ||
        invitation.dialog !== null ||
        cpuConfirmation !== null ||
        autoResult.visible
      }
      onSettingsOpenChange={(open) => setDialog(open ? "settings" : null)}
      gameSettings={gameSettings}
      feedbackButtonRef={feedbackButtonRef}
      onFeedback={() => {
        if (autoResult.visible) autoResult.dismiss();
        setDialog("feedback");
      }}
      session={session}
      cpuAddButtonRef={cpuAddButtonRef}
      canAddCpu={canAddCpu}
      onAddCpu={cpuAddition.request}
      shareButtonRef={shareButtonRef}
      onShare={invitation.openShare}
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
      stampPicker={
        session.stampsSupported &&
        membership &&
        session.self && (
          <RoomStampPicker
            theme={theme}
            disabled={
              !session.authenticated ||
              session.connection !== "接続済み" ||
              session.leaving ||
              dialog !== null ||
              invitation.dialog !== null ||
              cpuConfirmation !== null ||
              autoResult.visible
            }
            pending={session.pendingStamp}
            sendDisabled={session.pendingStamp || chat.pending || !session.interactionReady}
            closeSignal={`${room.instanceId}:${room.status}:${session.canPlay}:${dialog}:${invitation.dialog}:${cpuConfirmation !== null}:${autoResult.visible}:${session.connection}:${session.leaving}`}
            onSend={session.sendStamp}
          />
        )
      }
    />
  );
  const chatPanel = (
    <RoomChat chat={chat} session={session} visible={desktop || tab === "chat"} theme={theme} />
  );
  const connectionNotice = session.connection !== "接続済み" ? session.connection : null;
  const operationError = session.socketError ?? session.stampError;
  const pendingNotice =
    !connectionNotice && !operationError ? (registrationNotice ?? operationNotice) : null;

  return (
    <main
      className={`app-theme ${appThemeClasses[theme]} room-background relative flex flex-col h-dvh overflow-hidden text-ink text-sm leading-normal`}
      ref={fallbackFocusRef}
      tabIndex={-1}
    >
      {(connectionNotice || operationError || pendingNotice) && (
        <div
          className="absolute top-[calc(env(safe-area-inset-top)_+_8px)] left-1/2 -translate-x-1/2 z-10 pointer-events-none w-max max-w-[min(480px,calc(100%_-_16px))] rounded-lg py-[7px] px-4 bg-[#fff4dc] text-[#755b21] text-xs text-center break-words"
          role="status"
        >
          {connectionNotice}
          {connectionNotice && operationError ? " — " : ""}
          {operationError}
          {pendingNotice}
        </div>
      )}
      <RoomStampContext.Provider value={stamps}>
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
      </RoomStampContext.Provider>
      {!chat.toastManagedGlobally && <AppToastRegion queue={chat.toastQueue} theme={theme} />}
      {invitation.dialog === "share" && (
        <RoomShareDialog
          game={room.settings.game}
          invitation={invitation}
          theme={theme}
          onCopied={onCopied}
        />
      )}
      <RoomInvitationDialogs invitation={invitation} roomId={room.id} theme={theme} />
      {cpuConfirmation !== null && (
        <AppDialog
          size="compact"
          title="CPUを追加しますか？"
          onClose={cpuAddition.cancel}
          theme={theme}
        >
          <p className="mb-3 text-sm">追加するCPU：Lv{cpuConfirmation}</p>
          <CpuMatchNotice />
          <div className="mt-[22px] flex justify-end gap-[10px]">
            <AppButton size="compact" appearance="secondary" onPress={cpuAddition.cancel}>
              キャンセル
            </AppButton>
            <AppButton size="compact" isDisabled={!canAddCpu} onPress={cpuAddition.confirm}>
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
          busy={signIn.busy}
        >
          {result}
          {registrationCancelled && (
            <p role="status" className="mt-4 text-sm">
              登録手続きを中止しました。
            </p>
          )}
          {registrationResult && (
            <p role="status" className="mt-4 text-sm">
              {registrationResult.record === "complete"
                ? "この対局をマイページに追加しました。"
                : "この対局の引継ぎを受け付けました。棋譜の保存を待っています。"}
              このアカウントでそのまま再戦できます。
            </p>
          )}
          {accountAvailable &&
            membership &&
            !membership.accountLinked &&
            registrationMatchId(room) &&
            room.lastRound.players.some((player) => player.id === membership.playerId) && (
              <div className="mt-5">
                <RegistrationPrompt
                  game={room.settings.game}
                  humanOnly={room.lastRound.players.every(
                    (p) =>
                      (p.appearance?.kind ??
                        room.players.find((current) => current.id === p.id)?.kind) === "human",
                  )}
                  busy={signIn.busy}
                  pendingProvider={signIn.pendingProvider}
                  onRegister={(provider) => void signIn.start(provider)}
                  onDismiss={closeResult}
                />
                {signIn.message && (
                  <p role="alert" className="mt-3 text-sm text-danger">
                    {signIn.message}
                  </p>
                )}
                {(unfinishedRegistration || signIn.message) && (
                  <AppButtonLink to="/login" appearance="quiet">
                    登録手続きを確認・中止する
                  </AppButtonLink>
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
            {dialog === "leave" && room.settings.game === "four-gomoku" && selfEliminated
              ? "確定した順位は変わりません。"
              : dialog === "leave"
                ? !gameCatalog[room.settings.game].hasModes
                  ? "対局中に退室すると敗北になります。"
                  : "対局中に退室すると脱落になります。"
                : !gameCatalog[room.settings.game].hasModes
                  ? "投了すると敗北になります。"
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
              isPending={busy}
              appearance="danger"
              onPress={() => {
                if (dialog === "leave") void session.handleLeaveClick();
                else session.handleResignClick();
              }}
            >
              {dialog === "leave" ? "退室する" : "投了する"}
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
