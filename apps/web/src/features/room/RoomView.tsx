import { Button, Tabs, Toast } from "@heroui/react";
import { useRef, useState, useSyncExternalStore } from "react";
import { Link } from "react-router";
import { fourReversiLobbyPath } from "../../app/paths";
import { useRoomInvitation } from "./useRoomInvitation";
import { RoomInvitationDialogs } from "./RoomInvitationDialogs";
import { FourReversiBoard } from "./FourReversiBoard";
import { GameResultView } from "./GameResultView";
import { RoomChat } from "./RoomChat";
import { RoomInfo } from "./RoomInfo";
import { RoomStatus } from "./RoomStatus";
import { RoomDialog } from "./RoomDialog";
import { RoomIcon } from "./RoomIcon";
import { PlayerCard } from "./PlayerCard";
import { ReplayCard } from "./ReplayCard";
import { useRoomReplay } from "./useRoomReplay";
import { colorNames, orderedSeats } from "./roomPresentation";
import { type useRoomChat } from "./useRoomChat";
import { type useRoomSession } from "./useRoomSession";
import "../../shared/heroui.css";
import "./room.css";

const desktopQuery = "(min-width: 1280px)";
function subscribeDesktop(callback: () => void) {
  const media = window.matchMedia(desktopQuery);
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
}
const readDesktop = () => window.matchMedia(desktopQuery).matches;
const seats = ["bottom", "left", "top", "right"];
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
      <main className="four-reversi-room room-unavailable">
        <p role="alert">{session.unavailable}</p>
        <Link className="room-button room-button-secondary" to={fourReversiLobbyPath}>
          ロビーへ戻る
        </Link>
      </main>
    );

  const board = (
    <div className="room-table">
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
        <p className="room-pass-notice" role="status">
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
    <main className="four-reversi-room" ref={fallbackFocusRef} tabIndex={-1}>
      {(connectionNotice || session.socketError) && (
        <div className="room-notice" role="status">
          {connectionNotice}
          {connectionNotice && session.socketError ? " — " : ""}
          {session.socketError}
        </div>
      )}
      {desktop ? (
        <div className="room-layout room-desktop">
          <section
            className={`room-board-panel${replayCard ? " has-replay" : ""}`}
            aria-label="盤面とプレイヤー"
          >
            <div className="room-board-stage">{board}</div>
            {replayCard}
          </section>
          <section className="room-info-panel" aria-label="ルーム">
            {info}
          </section>
          {status}
          <section className="room-chat-panel" aria-label="チャット">
            {chatPanel}
          </section>
        </div>
      ) : (
        <Tabs
          className="room-layout room-mobile"
          selectedKey={tab}
          onSelectionChange={(key) => setTab(String(key))}
        >
          <Tabs.List aria-label="ルームの表示" className="room-tab-list">
            {(Object.keys(tabLabels) as (keyof typeof tabLabels)[]).map((key) => (
              <Tabs.Tab key={key} id={key} className="room-tab">
                <RoomIcon name={key === "room" ? "user" : key} />
                {tabLabels[key]}
                <Tabs.Indicator />
              </Tabs.Tab>
            ))}
          </Tabs.List>
          <Tabs.Panel id="board" className="room-board-panel room-tab-panel" shouldForceMount>
            {board}
          </Tabs.Panel>
          <Tabs.Panel id="room" className="room-info-panel room-tab-panel" shouldForceMount>
            {info}
          </Tabs.Panel>
          <Tabs.Panel id="chat" className="room-chat-panel room-tab-panel" shouldForceMount>
            {chatPanel}
          </Tabs.Panel>
          {status}
        </Tabs>
      )}
      <Toast.Provider
        queue={chat.toastQueue}
        placement="top"
        width="min(380px, calc(100vw - 24px))"
        className="room-toasts"
      >
        {({ toast }) => (
          <Toast toast={toast}>
            <Toast.Content>
              <Toast.Title>{toast.content.title}</Toast.Title>
              <Toast.Description>{toast.content.description}</Toast.Description>
            </Toast.Content>
            <Toast.CloseButton aria-label="通知を閉じる" />
          </Toast>
        )}
      </Toast.Provider>
      <RoomInvitationDialogs invitation={invitation} roomId={room.id} />
      {dialog === "result" && room.lastRound && (
        <RoomDialog title="対局結果" onClose={() => setDialog(null)}>
          <GameResultView lastRound={room.lastRound} />
        </RoomDialog>
      )}
      {(dialog === "leave" || dialog === "resign") && (
        <RoomDialog
          title={dialog === "leave" ? "ルームから退室しますか？" : "投了しますか？"}
          busy={busy}
          onClose={() => setDialog(null)}
        >
          <p>
            {dialog === "leave"
              ? "対局中に退室すると脱落になります。"
              : "投了すると脱落になります。対局の観戦とチャットは続けられます。"}
          </p>
          {session.socketError && (
            <p className="room-error" role="alert">
              {session.socketError}
            </p>
          )}
          <div className="room-dialog-actions">
            <Button
              className="room-button room-button-secondary"
              isDisabled={busy}
              onPress={() => setDialog(null)}
            >
              キャンセル
            </Button>
            <Button
              className="room-button room-button-danger"
              isDisabled={busy || (dialog === "resign" && !session.canPlay)}
              onPress={() => {
                if (dialog === "leave") void session.handleLeaveClick();
                else session.handleResignClick();
              }}
            >
              {busy ? "送信中…" : dialog === "leave" ? "退室する" : "投了する"}
            </Button>
          </div>
        </RoomDialog>
      )}
    </main>
  );
}
