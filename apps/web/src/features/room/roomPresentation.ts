import {
  type Room,
  type FourReversiRoom,
  type FourReversiMatchDetail,
  type MatchHistoryParticipant,
} from "@tetraboard/protocol";
import { clockPresentation } from "./roomClockPresentation";
import { createInitialState, type Color, type FourReversiState } from "@tetraboard/four-reversi";

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
export const playerName = (player: Room["players"][number] | MatchHistoryParticipant): string =>
  player.kind === "cpu" ? `CPU Lv${player.level}` : player.name;

export { formatClock } from "./roomClockPresentation";

export function playerClock(room: FourReversiRoom, color: Color | null, serverNowMs: number) {
  if (room.status === "playing" && color !== null) {
    if (room.game.eliminatedColors.includes(color)) return null;
    return clockPresentation({
      timeControl: room.settings.timeControl,
      remainingMainMs: room.clock.remainingMainMs[color],
      turnStartedAt: room.clock.turnStartedAt,
      turnExpiresAt: room.clock.turnExpiresAt,
      isTurn: room.game.turn === color,
      serverNowMs,
    });
  }
  return clockPresentation({ timeControl: room.settings.timeControl, serverNowMs });
}

export function orderedSeats<T extends Room>(room: T, selfId: string | undefined) {
  const seats: (T["players"][number] | null)[] = [...room.players];
  while (seats.length < 4) seats.push(null);
  const anchor =
    selfId === undefined
      ? 0
      : Math.max(
          0,
          seats.findIndex((player) => player?.id === selfId),
        );
  return Array.from({ length: 4 }, (_, index) => seats[(anchor + index) % 4]);
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
  const players = [...match.participants].sort((a, b) => a.seat - b.seat);
  const anchor = players.findIndex((player) => player.id === match.selfPlayerId);
  return players.map((_, index) => players[(anchor + index) % 4]);
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

export const seatPositions = ["bottom", "left", "top", "right"] as const;
