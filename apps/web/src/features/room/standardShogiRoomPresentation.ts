import { createInitialState, type Side } from "@tetraboard/shogi";
import type { ShogiRoom } from "@tetraboard/protocol";
export const shogiSideNames = { south: "先手", north: "後手" };
export const shogiEliminationLabels = {
  resigned: "投了",
  left: "退室",
  timeout: "時間切れ",
  disconnected: "通信切れ",
};
export function displayShogiGameForRoom(room: ShogiRoom) {
  return (
    room.game ??
    room.lastRound?.game ??
    createInitialState({ players: { south: "waiting-south", north: "waiting-north" } })
  );
}
export function shogiViewerSide(room: ShogiRoom, id?: string): Side {
  const game = room.game ?? room.lastRound?.game;
  return game && id && game.players.north === id ? "north" : "south";
}
export function shogiRoomSeats(room: ShogiRoom, id?: string) {
  if (room.status === "playing")
    return {
      south: room.players.find((p) => p.side === "south") ?? null,
      north: room.players.find((p) => p.side === "north") ?? null,
    };
  const first =
    room.players.find((p) => p.id === id) ??
    room.players.find((p) => p.id === room.lastRound?.game.players.south) ??
    room.players[0] ??
    null;
  const other = room.players.find((p) => p.id !== first?.id) ?? null;
  return shogiViewerSide(room, id) === "south"
    ? { south: first, north: other }
    : { north: first, south: other };
}
