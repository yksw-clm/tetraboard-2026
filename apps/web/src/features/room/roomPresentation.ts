import type { FourReversiRoom, FourReversiMatchDetail } from "@tetraboard/protocol";
import {
  colors,
  createInitialState,
  type Color,
  type FourReversiState,
} from "@tetraboard/four-reversi";

export const displayGameForRoom = (room: FourReversiRoom) =>
  room.status === "playing"
    ? room.game
    : (room.lastRound?.game ?? createInitialState(room.settings.mode));

export const colorNames: Record<Color, string> = {
  black: "黒",
  white: "白",
  red: "赤",
  blue: "青",
};
export { playerName, formatClock, seatPositions, orderedSeats } from "./roomCommonPresentation";
import { orderedSeats } from "./roomCommonPresentation";
export { playerClock } from "./playerClocks";

function colorOrderedSeats<T extends { id: string; color: Color }>(
  players: readonly T[],
  selfId: string | undefined,
): T[] {
  const seats = [...players].sort((a, b) => colors.indexOf(a.color) - colors.indexOf(b.color));
  const anchor = Math.max(
    0,
    seats.findIndex((player) => player.id === selfId),
  );
  return seats.map((_, index) => seats[(anchor + index) % seats.length]);
}

export function fourReversiRoomSeats(room: FourReversiRoom, selfId: string | undefined) {
  return room.status === "playing"
    ? colorOrderedSeats(room.players, selfId)
    : orderedSeats(room, selfId);
}

export const eliminationLabels = {
  resigned: "投了",
  left: "退室",
  timeout: "時間切れ",
  disconnected: "通信切れ",
} as const;

export function playerRank(room: FourReversiRoom, color: Color | null) {
  if (room.status !== "playing" || color === null) return null;
  const index = room.game.eliminatedColors.indexOf(color);
  if (index < 0) return null;
  const rank = 4 - index;
  const reason = room.eliminations.find((entry) => entry.color === color)?.reason;
  return { rank, label: `${rank}位${reason ? `（${eliminationLabels[reason]}）` : ""}` };
}

export function matchSeats(match: FourReversiMatchDetail) {
  return colorOrderedSeats(match.participants, match.selfPlayerId);
}

export function replayPlayerDetails(
  game: FourReversiState,
  color: Color,
  eliminations: FourReversiMatchDetail["eliminations"],
) {
  const index = game.eliminatedColors.indexOf(color);
  const eliminated = index >= 0;
  const reason = eliminated
    ? eliminations.find((entry) => entry.color === color)?.reason
    : undefined;
  let rank: { rank: number; label: string } | null = null;
  if (game.mode === "singles") {
    const standing =
      game.status === "finished" && game.result.mode === "singles"
        ? game.result.standings.find((entry) => entry.color === color)
        : null;
    const position = standing?.rank ?? (eliminated ? 4 - index : null);
    if (position !== null)
      rank = {
        rank: position,
        label: `${position}位${reason ? `（${eliminationLabels[reason]}）` : ""}`,
      };
  } else if (eliminated) {
    rank = { rank: 4, label: `脱落${reason ? `（${eliminationLabels[reason]}）` : ""}` };
  }
  return {
    count: eliminated ? null : game.board.flat().filter((cell) => cell === color).length,
    rank,
  };
}
