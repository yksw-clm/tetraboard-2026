import { Avatar, Badge, Card, Chip } from "@heroui/react";
import { type Room } from "@tetraboard/protocol";
import { useLayoutEffect, useRef } from "react";
import { colorNames, playerClock, playerName, playerRank } from "./roomPresentation";
import { RoomIcon } from "./RoomIcon";

export function PlayerCard({
  player,
  room,
  self,
  host,
  connected,
  now,
  position,
}: {
  player: Room["players"][number] | null;
  room: Room;
  self: boolean;
  host: boolean;
  connected: boolean;
  now: number;
  position: string;
}) {
  const color = room.status === "playing" ? player?.color : null;
  const rank = playerRank(room, color ?? null);
  const count =
    room.status === "playing" && color
      ? room.game.board.flat().filter((cell) => cell === color).length
      : 0;
  const clock = player ? playerClock(room, player.color, now) : null;
  const current = room.status === "playing" && color === room.game.turn;
  const name = player ? playerName(player) : "空席";
  const nameBox = useRef<HTMLDivElement>(null);
  const nameContent = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const box = nameBox.current;
    const content = nameContent.current;
    if (!box || !content) return;
    const fit = () => {
      if (box.clientWidth === 0) return;
      content.style.fontSize = "";
      const naturalWidth = content.getBoundingClientRect().width;
      const fontSize = Number.parseFloat(getComputedStyle(content).fontSize);
      if (naturalWidth > box.clientWidth)
        content.style.fontSize = `${fontSize * (box.clientWidth / naturalWidth)}px`;
    };
    fit();
    // 計測による文字サイズ変更をobserverの通知フレームから分離します。
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit);
    });
    observer.observe(box);
    document.fonts.addEventListener("loadingdone", fit);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      document.fonts.removeEventListener("loadingdone", fit);
    };
  }, [name, host, player?.kind]);
  return (
    <Card
      data-testid="player-card"
      className={`room-player room-seat-${position}${!player ? " is-empty" : ""}${self ? " is-self" : ""}${current ? " is-current" : ""}${rank ? " is-eliminated" : ""}`}
      aria-label={
        player ? `${playerName(player)}${self ? "、あなた" : ""}${host ? "、ホスト" : ""}` : "空席"
      }
    >
      <Badge.Anchor className="room-avatar-anchor">
        <Avatar data-testid="player-avatar" className="room-avatar" aria-hidden="true">
          <Avatar.Fallback>
            <RoomIcon name="user" />
          </Avatar.Fallback>
        </Avatar>
        {player && (
          <Badge
            className={`room-presence ${connected ? "is-connected" : "is-disconnected"}`}
            placement="bottom-right"
            size="sm"
            aria-label={connected ? "接続中" : "切断中"}
          />
        )}
      </Badge.Anchor>
      <div data-testid="player-name" className="room-player-name" ref={nameBox}>
        <span className="room-player-name-content" ref={nameContent}>
          {name}
          {host && (
            <span className="room-crown" title="ホスト">
              <RoomIcon name="crown" />
            </span>
          )}
          {player?.kind === "cpu" && (
            <span className="room-robot" title="CPU">
              <RoomIcon name="robot" />
            </span>
          )}
        </span>
      </div>
      <div className="room-player-detail">
        <span className="room-player-score">
          {room.status === "waiting"
            ? player?.ready && (
                <Chip className="room-ready" size="sm">
                  準備完了
                </Chip>
              )
            : color && (
                <span className="room-stone-count" aria-label={`${colorNames[color]}、${count}石`}>
                  <span className={`room-stone room-stone-${color}`} />
                  {count}
                </span>
              )}
        </span>
        {rank ? (
          <Chip className={`room-rank room-rank-${rank.rank}`} size="sm">
            {rank.label}
          </Chip>
        ) : (
          clock && (
            <span
              className={`room-clock${clock.byoyomi ? " is-byoyomi" : ""}${clock.urgent ? " is-urgent" : ""}`}
              aria-label={`${clock.byoyomi ? "秒読み" : "持ち時間"} ${clock.text}`}
            >
              {clock.text}
            </span>
          )
        )}
      </div>
    </Card>
  );
}
