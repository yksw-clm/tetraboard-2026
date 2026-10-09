import type { Room, RoomSocketClientMessage } from "@tetraboard/protocol";

export function commonSettingsComplete(
  room: Room,
  command: RoomSocketClientMessage,
  playerIds: ReadonlySet<string>,
): boolean {
  if (room.status !== "waiting") return true;
  switch (command.type) {
    case "room.mode.set":
      return room.settings.mode === command.mode;
    case "room.time-control.set":
      return (
        room.settings.timeControl.mainTimeMs === command.timeControl.mainTimeMs &&
        room.settings.timeControl.byoyomiMs === command.timeControl.byoyomiMs
      );
    case "room.cpu.add":
      return room.players.some((p) => p.kind === "cpu" && !playerIds.has(p.id));
    case "room.cpu.remove":
      return !room.players.some((p) => p.id === command.playerId);
    case "room.cpu.level.set":
      return room.players.some(
        (p) => p.id === command.playerId && p.kind === "cpu" && p.level === command.level,
      );
    default:
      return false;
  }
}
