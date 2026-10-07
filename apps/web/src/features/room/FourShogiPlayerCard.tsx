import { Chip } from "@heroui/react";
import type { Side } from "@tetraboard/four-shogi";
import type { FourShogiPublicState, FourShogiRoom } from "@tetraboard/protocol";
import { PlayerCardView, PlayerReadyBadge } from "./PlayerCardView";
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
      profileTarget={
        player
          ? { source: "room", roomId: room.id, instanceId: room.instanceId, playerId: player.id }
          : undefined
      }
      profileMode={room.settings.mode}
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
          <ShogiSideBadge side={side} proposed={room.game.drawProposals.includes(side)} />
        ) : player?.ready ? (
          <PlayerReadyBadge />
        ) : null
      }
    />
  );
}

export function ShogiSideBadge({ side, proposed }: { side: Side; proposed: boolean }) {
  return (
    <span
      className="inline-flex items-center gap-1 text-brand text-xs font-bold"
      aria-label={`担当方向 ${shogiSideNames[side]}${proposed ? "、引分提案中" : ""}`}
    >
      {shogiSideNames[side]}
      {proposed && (
        <Chip
          size="sm"
          className="h-4 px-1 py-0 text-[9px] font-bold text-[#896315] bg-[#fff0ba] rounded-[4px] whitespace-nowrap"
        >
          引分
        </Chip>
      )}
    </span>
  );
}
