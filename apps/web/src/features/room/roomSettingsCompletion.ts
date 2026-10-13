import type { Room, RoomSocketClientMessage } from "@tetraboard/protocol";

export function commonSettingsComplete(
  room: Room,
  command: RoomSocketClientMessage,
  playerIds: ReadonlySet<string>,
): boolean {
  if (room.status !== "waiting") return true;
  switch (command.type) {
    case "room.settings.apply": {
      if (command.mode !== undefined && room.settings.mode !== command.mode) return false;
      if (
        room.settings.timeControl.mainTimeMs !== command.timeControl.mainTimeMs ||
        room.settings.timeControl.byoyomiMs !== command.timeControl.byoyomiMs
      )
        return false;
      if (
        command.threePlayerAttackProhibited !== undefined &&
        (room.settings.game !== "four-shogi" ||
          room.settings.threePlayerAttackProhibited !== command.threePlayerAttackProhibited)
      )
        return false;
      if (
        command.forbiddenRules !== undefined &&
        (room.settings.game !== "gomoku" || room.settings.forbiddenRules !== command.forbiddenRules)
      )
        return false;
      const cpus = room.players.filter((player) => player.kind === "cpu");
      if (cpus.length !== command.cpus.length) return false;
      if (
        command.cpus.some(
          (cpu) =>
            cpu.playerId !== null &&
            !cpus.some((p) => p.id === cpu.playerId && p.level === cpu.level),
        )
      )
        return false;
      const added = cpus
        .filter((cpu) => !playerIds.has(cpu.id))
        .map((cpu) => cpu.level)
        .sort();
      const requested = command.cpus
        .filter((cpu) => cpu.playerId === null)
        .map((cpu) => cpu.level)
        .sort();
      return JSON.stringify(added) === JSON.stringify(requested);
    }
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
