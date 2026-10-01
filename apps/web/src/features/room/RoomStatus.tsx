import { Button, Card } from "@heroui/react";
import { playerClock, playerName } from "./roomPresentation";
import { type useRoomSession } from "./useRoomSession";

export function RoomStatus({
  session,
  onResults,
  onResign,
}: {
  session: ReturnType<typeof useRoomSession>;
  onResults: () => void;
  onResign: () => void;
}) {
  const { room, self, membership, presence, authenticated, connection } = session;
  const waiting = room.status === "waiting";
  const turn =
    room.status === "playing"
      ? room.players.find((player) => player.color === room.game.turn)
      : null;
  const myTurn = !!turn && turn.id === self?.id;
  const clock = turn ? playerClock(room, turn.color, session.serverNowMs) : null;
  const available =
    authenticated &&
    connection === "接続済み" &&
    !session.leaving &&
    session.pendingGameAction === null;
  const ready = available && session.pendingReady === null;
  const canStart =
    ready &&
    room.players.length === 4 &&
    room.players.every((player) => player.ready && presence.connectedPlayerIds.includes(player.id));
  return (
    <Card className="room-status" aria-label="対局状況">
      <div className="room-status-copy">
        <strong className={myTurn ? "room-my-turn" : undefined} aria-live="polite">
          {waiting
            ? "待機中です。"
            : myTurn
              ? "あなたの番です。"
              : `${turn ? playerName(turn) : ""}の番です。`}
        </strong>
        <div className="room-status-secondary">
          {waiting ? (
            room.lastRound ? (
              <Button variant="ghost" size="sm" className="room-result-button" onPress={onResults}>
                結果
              </Button>
            ) : (
              `参加者 ${room.players.length}/4`
            )
          ) : (
            clock && (
              <span
                className={`room-clock${clock.byoyomi ? " is-byoyomi" : ""}${clock.urgent ? " is-urgent" : ""}`}
              >
                {clock.byoyomi ? "秒読み " : "残り "}
                {clock.text}
              </span>
            )
          )}
        </div>
      </div>
      <div className="room-status-actions">
        {waiting && self && membership && (
          <Button
            className={`room-button ${self.ready ? "room-button-secondary" : "room-button-primary"}`}
            isDisabled={!ready}
            onPress={session.handleReadyClick}
          >
            {self.ready ? "準備取消" : "準備完了"}
          </Button>
        )}
        {waiting && membership?.role === "host" && (
          <Button
            className="room-button room-button-primary"
            isDisabled={!canStart}
            onPress={session.handleStartClick}
          >
            対局開始
          </Button>
        )}
        {myTurn && (
          <Button
            className="room-button room-button-danger"
            isDisabled={!session.canPlay}
            onPress={onResign}
          >
            投了
          </Button>
        )}
      </div>
    </Card>
  );
}
