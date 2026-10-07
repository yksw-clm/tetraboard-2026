import type {
  FourReversiRoom,
  PlayerProfileTarget,
  FourReversiMatchDetail,
  FourReversiMatchHistoryParticipant,
} from "@tetraboard/protocol";
import type { FourReversiState } from "@tetraboard/four-reversi";
import { playerClock, playerRank, replayPlayerDetails } from "./roomPresentation";
import { PlayerStoneCount } from "./PlayerStoneCount";
import { PlayerCardView, PlayerReadyBadge } from "./PlayerCardView";
export { PlayerCardView, PlayerReadyBadge } from "./PlayerCardView";
export function PlayerCard({
  player,
  room,
  replay,
  self,
  host,
  connected,
  now,
  position,
  profileTarget,
}: {
  player: FourReversiRoom["players"][number] | FourReversiMatchHistoryParticipant | null;
  self: boolean;
  host: boolean;
  connected?: boolean;
  profileTarget?: PlayerProfileTarget;
  position: Parameters<typeof PlayerCardView>[0]["position"];
} & (
  | { room: FourReversiRoom; now: number; replay?: never }
  | {
      room?: never;
      now?: never;
      replay: { game: FourReversiState; eliminations: FourReversiMatchDetail["eliminations"] };
    }
)) {
  const color = replay ? player?.color : room.status === "playing" ? player?.color : null;
  const replayDetails =
    replay && color ? replayPlayerDetails(replay.game, color, replay.eliminations) : null;
  const rank = replayDetails ? replayDetails.rank : room ? playerRank(room, color ?? null) : null;
  const count = replayDetails
    ? replayDetails.count
    : room?.status === "playing" && color
      ? room.game.board.flat().filter((cell) => cell === color).length
      : 0;
  const clock = room && player ? playerClock(room, player.color, now) : null;
  const current = room?.status === "playing" && color === room.game.turn;
  return (
    <PlayerCardView
      profileTarget={
        room && player
          ? { source: "room", roomId: room.id, instanceId: room.instanceId, playerId: player.id }
          : profileTarget
      }
      profileMode={room?.settings.mode ?? replay?.game.mode}
      player={player}
      self={self}
      host={host}
      connected={connected}
      position={position}
      current={current}
      rank={rank}
      clock={clock}
      score={
        room?.status === "waiting"
          ? player && "ready" in player && player.ready && <PlayerReadyBadge />
          : color && <PlayerStoneCount color={color} count={count} />
      }
    />
  );
}
