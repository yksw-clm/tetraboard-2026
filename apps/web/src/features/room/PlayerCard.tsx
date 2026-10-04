import type {
  FourReversiRoom,
  FourReversiMatchDetail,
  FourReversiMatchHistoryParticipant,
} from "@tetraboard/protocol";
import type { FourReversiState } from "@tetraboard/four-reversi";
import { colorNames, playerClock, playerRank, replayPlayerDetails } from "./roomPresentation";
import { Stone } from "./Stone";
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
}: {
  player: FourReversiRoom["players"][number] | FourReversiMatchHistoryParticipant | null;
  self: boolean;
  host: boolean;
  connected?: boolean;
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
          : color && (
              <span
                data-testid="player-stone-count"
                className="inline-flex shrink-0 items-center gap-[6px] text-[13px] font-bold tabular-nums [@container(max-width:160px)]:text-[11px] [@container(max-width:160px)]:gap-[3px]"
                aria-label={`${colorNames[color]}${count === null ? "" : `、${count}石`}`}
              >
                <Stone
                  color={color}
                  className="size-[19px] shadow-[inset_0_-1px_2px_#0002] [@container(max-width:160px)]:size-4"
                />
                {count}
              </span>
            )
      }
    />
  );
}
