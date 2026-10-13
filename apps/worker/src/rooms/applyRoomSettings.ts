import { roomSchema, type Room, type RoomSettingsApplyCommand } from "@tetraboard/protocol";
import { gameCatalog } from "@tetraboard/protocol/games";
import { nextPublicUpdateAt } from "./progressHelpers";

export function prepareRoomSettings(
  room: Room,
  command: RoomSettingsApplyCommand,
):
  | { status: "updated"; room: Room }
  | {
      status:
        | "unchanged"
        | "already_started"
        | "room_changed"
        | "invalid_request"
        | "cpu_not_found"
        | "room_full";
    } {
  if (room.status !== "waiting") return { status: "already_started" };
  if (room.publicUpdatedAtMs !== command.expectedPublicUpdatedAtMs)
    return { status: "room_changed" };
  if (
    gameCatalog[room.settings.game].hasModes !== (command.mode !== undefined) ||
    (room.settings.game === "four-shogi") !== (command.threePlayerAttackProhibited !== undefined) ||
    (room.settings.game === "gomoku") !== (command.forbiddenRules !== undefined)
  )
    return { status: "invalid_request" };
  const existing = room.players.filter((player) => player.kind === "cpu");
  const retained = new Map(
    command.cpus.flatMap((cpu) =>
      cpu.playerId === null ? [] : [[cpu.playerId, cpu.level] as const],
    ),
  );
  if ([...retained.keys()].some((id) => !existing.some((cpu) => cpu.id === id)))
    return { status: "cpu_not_found" };
  const humanCount = room.players.filter((player) => player.kind === "human").length;
  if (humanCount + command.cpus.length > gameCatalog[room.settings.game].capacity)
    return { status: "room_full" };
  const settings = {
    ...room.settings,
    timeControl: command.timeControl,
    ...(command.mode === undefined ? {} : { mode: command.mode }),
    ...(command.threePlayerAttackProhibited === undefined
      ? {}
      : { threePlayerAttackProhibited: command.threePlayerAttackProhibited }),
    ...(command.forbiddenRules === undefined ? {} : { forbiddenRules: command.forbiddenRules }),
  };
  const settingsChanged = JSON.stringify(settings) !== JSON.stringify(room.settings);
  const players: Room["players"][number][] = [];
  for (const player of room.players) {
    if (player.kind === "human")
      players.push(settingsChanged ? { ...player, ready: false } : player);
    else {
      const level = retained.get(player.id);
      if (level !== undefined) players.push({ ...player, level });
    }
  }
  const usedNames = new Set(
    players.filter((player) => player.kind === "cpu").map((player) => player.name),
  );
  for (const cpu of command.cpus.filter((cpu) => cpu.playerId === null)) {
    const number = [1, 2, 3].find((number) => !usedNames.has(`CPU ${number}`));
    if (number === undefined) return { status: "room_full" };
    const name = `CPU ${number}`;
    usedNames.add(name);
    players.push({
      id: crypto.randomUUID(),
      name,
      kind: "cpu",
      level: cpu.level,
      ready: true,
      reconnectDeadline: null,
      ...(room.settings.game === "four-shogi" || room.settings.game === "shogi"
        ? { side: null }
        : { color: null }),
    });
  }
  if (!settingsChanged && JSON.stringify(players) === JSON.stringify(room.players))
    return { status: "unchanged" };
  const updated = roomSchema.safeParse({
    ...room,
    settings,
    players,
    lastActivityAtMs: Date.now(),
    publicUpdatedAtMs: nextPublicUpdateAt(room),
  });
  return updated.success
    ? { status: "updated", room: updated.data }
    : { status: "invalid_request" };
}
