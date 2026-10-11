import { standingReasons } from "./fourGomokuPresentation";
import type {
  FourGomokuRoom,
  ReplayFourGomokuMatch,
  PlayerProfileTarget,
} from "@tetraboard/protocol";
import type { FourGomokuState } from "@tetraboard/four-gomoku";
import { PlayerCardView, PlayerReadyBadge } from "./PlayerCardView";
import { PlayerStoneCount } from "./PlayerStoneCount";
import { playerClock } from "./playerClocks";
export function FourGomokuPlayerCard({
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
  player: FourGomokuRoom["players"][number] | ReplayFourGomokuMatch["participants"][number] | null;
  position: Parameters<typeof PlayerCardView>[0]["position"];
  self: boolean;
  host: boolean;
  connected?: boolean;
  room?: FourGomokuRoom;
  game?: FourGomokuState;
  now?: number;
  profileTarget?: PlayerProfileTarget;
}) {
  const color = room?.status === "waiting" ? null : player?.color;
  const state = game ?? (room?.status === "playing" ? room.game : null);
  const clock = room ? playerClock(room, color ?? null, now) : null;
  const standing = state?.standings.find((s) => s.color === color);
  return (
    <PlayerCardView
      game="four-gomoku"
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
      profileMode={room?.settings.mode ?? state?.mode}
      rank={
        standing
          ? {
              rank: standing.rank,
              label: `${standing.rank}位（${standingReasons[standing.reason]}）`,
            }
          : null
      }
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
