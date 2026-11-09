import type { Room } from "@tetraboard/protocol";
import { matchmakingPath } from "./paths";
export function managedRoomPath(room: Room) {
  if ("matchmaking" in room && room.matchmaking) return matchmakingPath(room.settings.game);
  return "tournamentId" in room && room.tournamentId !== undefined
    ? `/tournaments/${room.tournamentId}`
    : null;
}
export function isMatchmakingRoom(room: Room) {
  return "matchmaking" in room && room.matchmaking !== undefined;
}
