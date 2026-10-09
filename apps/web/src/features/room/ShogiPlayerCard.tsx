import type { ShogiRoom, ShogiPublicState } from "@tetraboard/protocol";
import type { Side } from "@tetraboard/shogi";
import { PlayerCardView, PlayerReadyBadge } from "./PlayerCardView";
import { shogiPlayerClock } from "./playerClocks";
import { shogiSideNames } from "./standardShogiRoomPresentation";
export function ShogiSideBadge({ side, proposed }: { side: Side; proposed: boolean }) {
  return (
    <span className="text-brand text-xs font-bold whitespace-nowrap">
      {shogiSideNames[side]}
      {proposed && <span className="ml-1 text-[10px]">持将棋</span>}
    </span>
  );
}
export function ShogiPlayerCard({
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
  player: ShogiRoom["players"][number] | null;
  room: ShogiRoom;
  game?: ShogiPublicState;
  side: Side;
  self: boolean;
  host: boolean;
  connected: boolean;
  now: number;
  position: "top" | "bottom";
}) {
  const displayed = game ?? room.game;
  const playedSide =
    displayed && player ? (displayed.players.south === player.id ? "south" : "north") : side;
  const rank =
    displayed?.status === "finished" && displayed.players[playedSide] === player?.id
      ? {
          rank: displayed.result.winner === null || displayed.result.winner === playedSide ? 1 : 2,
          label:
            displayed.result.winner === null
              ? "引き分け"
              : displayed.result.winner === playedSide
                ? "勝利"
                : "敗北",
        }
      : null;
  return (
    <PlayerCardView
      shogi
      game="shogi"
      player={player}
      self={self}
      host={host}
      connected={connected}
      position={position}
      current={room.status === "playing" && side === room.game.turn}
      clock={player ? shogiPlayerClock(room, room.status === "playing" ? side : null, now) : null}
      rank={rank}
      profileTarget={
        player
          ? { source: "room", roomId: room.id, instanceId: room.instanceId, playerId: player.id }
          : undefined
      }
      score={
        room.status === "playing" || game ? (
          <ShogiSideBadge
            side={playedSide}
            proposed={displayed?.drawProposals.includes(playedSide) ?? false}
          />
        ) : player?.ready ? (
          <PlayerReadyBadge />
        ) : null
      }
    />
  );
}
