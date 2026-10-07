import type { Room, MatchHistoryParticipant, PlayerAppearance } from "@tetraboard/protocol";
export const playerName = (player: Room["players"][number] | MatchHistoryParticipant): string =>
  player.kind === "cpu" ? `CPU Lv${player.level}` : player.name;

export { formatClock } from "./roomClockPresentation";

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

export const seatPositions = ["bottom", "left", "top", "right"] as const;

export function playerAppearance(
  player: Room["players"][number] | MatchHistoryParticipant,
): PlayerAppearance {
  return player.kind === "cpu"
    ? { kind: "cpu", level: player.level }
    : { kind: "human", avatarUrl: player.avatarUrl };
}
