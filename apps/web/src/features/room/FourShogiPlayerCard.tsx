import { type Side } from "@tetraboard/four-shogi";
import { type FourShogiPublicState, type FourShogiRoom } from "@tetraboard/protocol";
import { PlayerCardView, PlayerReadyBadge } from "./PlayerCard";
import {
  shogiPlayerClock,
  shogiPlayerRank,
  shogiReplayPlayerRank,
  shogiSideNames,
} from "./fourShogiRoomPresentation";

export function FourShogiPlayerCard({
  player,
  room,
  game,
  side,
  self,
  host,
  connected,
  now,
  position,
}: {
  player: FourShogiRoom["players"][number] | null;
  room: FourShogiRoom;
  game?: FourShogiPublicState;
  side: Side;
  self: boolean;
  host: boolean;
  connected: boolean;
  now: number;
  position: "top" | "bottom" | "left" | "right";
}) {
  const playing = room.status === "playing";
  // 再戦の席順と前局の方向は異なるため、閲覧局面の順位を参加者IDで対応付けます。
  const rank = game
    ? shogiReplayPlayerRank(room, game, player?.id)
    : playing
      ? shogiPlayerRank(room.game, side)
      : null;
  return (
    <PlayerCardView
      shogi
      player={player}
      self={self}
      host={host}
      connected={connected}
      position={position}
      current={playing && side === room.game.turn}
      clock={player ? shogiPlayerClock(room, playing ? side : null, now) : null}
      rank={rank}
      score={
        playing ? (
          <span
            className="text-brand text-xs font-bold"
            aria-label={`担当方向 ${shogiSideNames[side]}`}
          >
            {shogiSideNames[side]}
          </span>
        ) : player?.ready ? (
          <PlayerReadyBadge />
        ) : null
      }
    />
  );
}
