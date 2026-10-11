import { colors, type Standing } from "@tetraboard/four-gomoku";
import type { FourGomokuRoom } from "@tetraboard/protocol";
import { orderedSeats } from "./roomCommonPresentation";
export const standingReasons: Record<Standing["reason"], string> = {
  five: "五連完成",
  resigned: "投了",
  left: "退室",
  timeout: "時間切れ",
  disconnected: "通信切れ",
  last_player: "最後の1人",
  board_full: "満盤・引き分け",
};
export function colorSeats<T extends { id: string; color: (typeof colors)[number] }>(
  players: readonly T[],
  selfId?: string,
): T[] {
  const seats = [...players].sort((a, b) => colors.indexOf(a.color) - colors.indexOf(b.color));
  const anchor = Math.max(
    0,
    seats.findIndex((p) => p.id === selfId),
  );
  return seats.map((_, i) => seats[(anchor + i) % seats.length]);
}
export function fourGomokuRoomSeats(room: FourGomokuRoom, selfId?: string) {
  return room.status === "playing" ? colorSeats(room.players, selfId) : orderedSeats(room, selfId);
}
