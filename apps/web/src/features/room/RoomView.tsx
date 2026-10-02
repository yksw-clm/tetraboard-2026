import { AppTabs } from "../../shared/ui/AppTabs";
import { AppButton } from "../../shared/ui/AppButton";
import { Toast } from "@heroui/react";
import { useRef, useState, useSyncExternalStore } from "react";
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
import { AppIcon } from "../../shared/ui/AppIcon";
import { PlayerCard } from "./PlayerCard";
import { ReplayCard } from "./ReplayCard";
import { useRoomReplay } from "./useRoomReplay";
import { colorNames, orderedSeats } from "./roomPresentation";
import { type useRoomChat } from "./useRoomChat";
import { type useRoomSession } from "./useRoomSession";

const desktopQuery = "(min-width: 1280px)";
function subscribeDesktop(callback: () => void) {
  const media = window.matchMedia(desktopQuery);
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
}
const readDesktop = () => window.matchMedia(desktopQuery).matches;
const seats = ["bottom", "left", "top", "right"] as const;
const tabLabels = { board: "盤面", room: "ルーム", chat: "チャット" } as const;

export function RoomView({
  session,
  chat,
  invited,
}: {
  session: ReturnType<typeof useRoomSession>;
  chat: ReturnType<typeof useRoomChat>;
  invited: boolean;
}) {
  const desktop = useSyncExternalStore(subscribeDesktop, readDesktop, () => false);
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
    <div className="[--player-height:60px] [--seat-width:clamp(168px,23cqw,280px)] [--board-size:max(160px,min(640px,calc(100cqw_-_2_*_var(--seat-width)_-_16px),calc(100cqh_-_2_*_var(--player-height)_-_32px)))] grid w-full min-h-full py-2 px-0 grid-cols-[var(--seat-width)_var(--board-size)_var(--seat-width)] grid-rows-[var(--player-height)_var(--board-size)_var(--player-height)] [grid-template-areas:'._top_.'_'left_board_right'_'._bottom_.'] gap-2 content-center justify-center items-center relative [@media(max-width:767px)]:[--seat-width:100%] [@media(max-width:767px)]:grid-cols-2 [@media(max-width:767px)]:grid-rows-[var(--player-height)_auto_var(--player-height)] [@media(max-width:767px)]:[grid-template-areas:'left_top'_'board_board'_'bottom_right'] [@media(max-width:767px)]:gap-[6px] [@media(max-width:767px)]:content-start [@media(max-width:767px)]:p-0">
      {orderedSeats(room, membership?.playerId).map((player, index) => (
        <PlayerCard
          key={seats[index]}
          position={seats[index]}
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
    </div>
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
      {desktop ? (
        <div className="flex-1 min-w-0 min-h-0 p-3 gap-3 grid grid-cols-[minmax(0,1fr)_360px] grid-rows-[auto_auto_minmax(140px,1fr)]">
          <section
            className="min-w-0 min-h-0 [container-type:size] overflow-auto col-start-1 row-span-3 relative flex flex-col gap-2"
            aria-label="盤面とプレイヤー"
          >
            <div className="flex-1 min-w-0 min-h-0 [container-type:size] overflow-auto">
              {board}
            </div>
            {replayCard}
          </section>
          <section
            className="min-w-0 [@media(min-width:1280px)]:col-start-2 [@media(min-width:1280px)]:row-start-1 [@media(max-width:1279px)]:overflow-y-auto [@media(max-width:767px)]:p-[2px]"
            aria-label="ルーム"
          >
            {info}
          </section>
          {status}
          <section
            className="min-w-0 min-h-0 [@media(min-width:1280px)]:col-start-2 [@media(min-width:1280px)]:row-start-3 [@media(max-width:767px)]:p-[2px]"
            aria-label="チャット"
          >
            {chatPanel}
          </section>
        </div>
      ) : (
        <AppTabs
          className="flex-1 min-w-0 min-h-0 grid grid-cols-1 grid-rows-[minmax(0,1fr)_auto_auto] gap-2 pt-[6px] px-3 pb-[max(6px,env(safe-area-inset-bottom))] [@media(max-width:767px)]:pt-1 [@media(max-width:767px)]:px-1 [@media(max-width:767px)]:pb-[max(4px,env(safe-area-inset-bottom))] [@media(max-width:767px)]:gap-[6px]"
          selectedKey={tab}
          onSelectionChange={(key) => setTab(String(key))}
        >
          <AppTabs.List aria-label="ルームの表示" className="col-start-1 row-start-3 w-full h-12">
            {(Object.keys(tabLabels) as (keyof typeof tabLabels)[]).map((key) => (
              <AppTabs.Tab key={key} id={key} className="h-full p-2 text-xs [&_svg]:size-4">
                <AppIcon name={key === "room" ? "user" : key} />
                {tabLabels[key]}
                <AppTabs.Indicator />
              </AppTabs.Tab>
            ))}
          </AppTabs.List>
          <AppTabs.Panel
            id="board"
            className="min-w-0 min-h-0 [container-type:size] overflow-auto [@media(min-width:1280px)]:col-start-1 [@media(min-width:1280px)]:row-span-3 [@media(min-width:1280px)]:relative [@media(min-width:1280px)]:flex [@media(min-width:1280px)]:flex-col [@media(min-width:1280px)]:gap-2 col-start-1 row-start-1 p-0 min-w-0 min-h-0 [&[inert]]:hidden [&[hidden]]:hidden"
            shouldForceMount
          >
            {board}
          </AppTabs.Panel>
          <AppTabs.Panel
            id="room"
            className="min-w-0 [@media(min-width:1280px)]:col-start-2 [@media(min-width:1280px)]:row-start-1 [@media(max-width:1279px)]:overflow-y-auto [@media(max-width:767px)]:p-[2px] col-start-1 row-start-1 p-0 min-w-0 min-h-0 [&[inert]]:hidden [&[hidden]]:hidden"
            shouldForceMount
          >
            {info}
          </AppTabs.Panel>
          <AppTabs.Panel
            id="chat"
            className="min-w-0 min-h-0 [@media(min-width:1280px)]:col-start-2 [@media(min-width:1280px)]:row-start-3 [@media(max-width:767px)]:p-[2px] col-start-1 row-start-1 p-0 min-w-0 min-h-0 [&[inert]]:hidden [&[hidden]]:hidden"
            shouldForceMount
          >
            {chatPanel}
          </AppTabs.Panel>
          {status}
        </AppTabs>
      )}
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
