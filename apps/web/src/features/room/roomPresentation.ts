import { type Room, type MatchDetail, type MatchHistoryParticipant } from "@tetraboard/protocol";
import { createInitialState, type Color, type FourReversiState } from "@tetraboard/four-reversi";

export const displayGameForRoom = (room: Room) =>
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

export function formatClock(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function playerClock(room: Room, color: Color | null, serverNowMs: number) {
  let remaining = room.settings.timeControl.mainTimeMs as number;
  let byoyomi = remaining === 0;
  if (room.status === "playing" && color !== null) {
    if (room.game.eliminatedColors.includes(color)) return null;
    const main = room.clock.remainingMainMs[color];
    const elapsed =
      room.game.turn === color ? Math.max(0, serverNowMs - room.clock.turnStartedAt) : 0;
    remaining = Math.max(0, main - elapsed);
    byoyomi = remaining === 0;
    if (byoyomi)
      remaining =
        room.game.turn === color
          ? Math.max(0, room.clock.turnExpiresAt - serverNowMs)
          : room.settings.timeControl.byoyomiMs;
  } else if (byoyomi) remaining = room.settings.timeControl.byoyomiMs;
  return {
    text: formatClock(remaining),
    byoyomi,
    urgent: byoyomi && Math.ceil(remaining / 1000) < 10,
  };
}

export function orderedSeats(room: Room, selfId: string | undefined) {
  const seats: (Room["players"][number] | null)[] = [...room.players];
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

export function playerRank(room: Room, color: Color | null) {
  if (room.status !== "playing" || color === null) return null;
  const index = room.game.eliminatedColors.indexOf(color);
  if (index < 0) return null;
  const rank = 4 - index;
  const reason = room.eliminations.find((entry) => entry.color === color)?.reason;
  return { rank, label: `${rank}位${reason ? `（${eliminationLabels[reason]}）` : ""}` };
}

export function matchSeats(match: MatchDetail) {
  const players = [...match.participants].sort((a, b) => a.seat - b.seat);
  const anchor = players.findIndex((player) => player.id === match.selfPlayerId);
  return players.map((_, index) => players[(anchor + index) % 4]);
}

export function replayPlayerDetails(
  game: FourReversiState,
  color: Color,
  eliminations: MatchDetail["eliminations"],
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
