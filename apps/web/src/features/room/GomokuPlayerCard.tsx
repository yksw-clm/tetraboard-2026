import type { GomokuRoom, ReplayGomokuMatch, PlayerProfileTarget } from "@tetraboard/protocol";
import type { GomokuState } from "@tetraboard/gomoku";
import { PlayerCardView, PlayerReadyBadge } from "./PlayerCardView";
import { PlayerStoneCount } from "./PlayerStoneCount";
import { reversiPlayerClock } from "./playerClocks";
export function GomokuPlayerCard({
  player,
  position,
  self,
  host,
  connected,
  room,
  game,
  now = 0,
  profileTarget,
}: {
  player: GomokuRoom["players"][number] | ReplayGomokuMatch["participants"][number] | null;
  position: "top" | "bottom";
  self: boolean;
  host: boolean;
  connected?: boolean;
  room?: GomokuRoom;
  game?: GomokuState;
  now?: number;
  profileTarget?: PlayerProfileTarget;
}) {
  const color = room?.status === "waiting" ? null : player?.color;
  const state = game ?? (room?.status === "playing" ? room.game : null);
  const clock = room ? reversiPlayerClock(room, color ?? null, now) : null;
  return (
    <PlayerCardView
      game="gomoku"
      profileTarget={
        room && player
          ? { source: "room", roomId: room.id, instanceId: room.instanceId, playerId: player.id }
          : profileTarget
      }
      player={player}
      position={position}
      self={self}
      host={host}
      connected={connected}
      current={room?.status === "playing" && color === room.game.turn}
      rank={null}
      clock={clock}
      score={
        room?.status === "waiting"
          ? player && "ready" in player && player.ready && <PlayerReadyBadge />
          : color &&
            state && (
              <PlayerStoneCount
                color={color}
                count={state.board.flat().filter((c) => c === color).length}
              />
            )
      }
    />
  );
}
