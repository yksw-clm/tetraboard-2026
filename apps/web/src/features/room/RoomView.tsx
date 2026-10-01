import { Link } from "react-router";
import { fourReversiLobbyPath } from "../../app/paths";
import { FourReversiBoard } from "./FourReversiBoard";
import { GameResultView } from "./GameResultView";
import { PlayerList } from "./PlayerList";
import { RoomChat } from "./RoomChat";
import { WaitingControls } from "./WaitingControls";
import { type useRoomChat } from "./useRoomChat";
import { type useRoomSession } from "./useRoomSession";

export function RoomView({
  session,
  chat,
}: {
  session: ReturnType<typeof useRoomSession>;
  chat: ReturnType<typeof useRoomChat>;
}) {
  const { room, membership } = session;

  return (
    <>
      <p>
        <Link to={fourReversiLobbyPath}>ロビーへ</Link>
      </p>
      <h1>ルーム {room.id}</h1>
      <p>
        参加区分：{membership?.role === "host" ? "ホスト" : membership ? "プレイヤー" : "観戦者"}
      </p>
      <p>接続状態：{session.connection}</p>
      {session.socketError && <p>{session.socketError}</p>}
      <p>状態：{room.status}</p>
      <p>ゲーム：四人リバーシ</p>
      <p>
        持ち時間：{room.settings.timeControl.mainTimeMs / 60_000}分＋1手
        {room.settings.timeControl.byoyomiMs / 1000}秒
      </p>
      <WaitingControls
        room={room}
        membership={membership}
        authenticated={session.authenticated}
        connection={session.connection}
        canManageSettings={session.canManageSettings}
        pendingReady={session.pendingReady}
        pendingGameAction={session.pendingGameAction !== null}
        leaving={session.leaving}
        newCpuLevel={session.newCpuLevel}
        onLeave={() => void session.handleLeaveClick()}
        onReady={session.handleReadyClick}
        onStart={session.handleStartClick}
        onModeChange={session.changeMode}
        onCpuLevelChange={session.setNewCpuLevel}
        onCpuAdd={session.addCpu}
      />
      <PlayerList
        room={room}
        membership={membership}
        serverNowMs={session.serverNowMs}
        canManageSettings={session.canManageSettings}
        onCpuLevelChange={session.changeCpuLevel}
        onCpuRemove={session.removeCpu}
      />
      {room.status === "waiting" && room.lastRound !== null && (
        <GameResultView lastRound={room.lastRound} />
      )}
      {session.displayGame !== null && (
        <FourReversiBoard
          room={room}
          game={session.displayGame}
          legalMoves={session.legalMoves}
          canPlay={session.canPlay}
          pendingGameAction={session.pendingGameAction !== null}
          onResign={session.handleResignClick}
          onPlaceStone={session.handlePlaceStone}
        />
      )}
      <RoomChat
        messages={session.chatMessages}
        membership={membership}
        authenticated={session.authenticated}
        connection={session.connection}
        input={chat.input}
        error={chat.error}
        reporting={chat.reporting}
        hiddenSenders={chat.hiddenSenders}
        onInputChange={chat.setInput}
        onSubmit={chat.handleSubmit}
        onToggleSender={chat.toggleSender}
        onReport={(messageId) => void chat.handleReport(messageId)}
      />
    </>
  );
}
