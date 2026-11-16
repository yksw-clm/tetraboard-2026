import { gameCapacity, roomSchema, type Room } from "@tetraboard/protocol";
import { nextPublicUpdateAt } from "../progressHelpers";
import type { AdapterDependencies, SettingsCommand, SettingsResult } from "./types";

type Waiting = Extract<Room, { status: "waiting" }>;
type CpuCommand = Extract<
  SettingsCommand,
  { type: "room.cpu.add" | "room.cpu.remove" | "room.cpu.level.set" }
>;
export type SettingsPolicy = {
  waitingSeat: { side: null } | { color: null };
  supportsMode: boolean;
  special?: (room: Room, hash: string, command: SettingsCommand) => SettingsResult;
};

export function updateSettings(
  dependencies: AdapterDependencies,
  policy: SettingsPolicy,
  room: Room,
  hash: string,
  command: SettingsCommand,
): SettingsResult {
  if (
    command.type === "room.gomoku-forbidden.set" ||
    command.type === "room.three-player-attack.set"
  )
    return policy.special?.(room, hash, command) ?? { status: "invalid_request" };
  if (room.status !== "waiting") return { status: "already_started" };
  if (dependencies.membership(hash)?.role !== "host") return { status: "forbidden" };
  if (command.type === "room.mode.set") {
    if (!policy.supportsMode) return { status: "forbidden" };
    if (room.settings.mode === command.mode) return { status: "unchanged" };
    dependencies.appendSystem(
      "mode_changed",
      `対局形式が${command.mode === "singles" ? "シングルス" : "ダブルス"}に変更されました`,
    );
    return {
      status: "updated",
      room: roomSchema.parse({
        ...room,
        settings: { ...room.settings, mode: command.mode },
        publicUpdatedAtMs: nextPublicUpdateAt(room),
        lastActivityAtMs: Date.now(),
        players: room.players.map((player) =>
          player.kind === "human" ? { ...player, ready: false } : player,
        ),
      }),
    };
  }
  return updateCpu(dependencies, policy, room, command);
}

function addCpu(
  dependencies: AdapterDependencies,
  policy: SettingsPolicy,
  room: Waiting,
  level: 1 | 2,
): SettingsResult {
  if (room.players.length >= gameCapacity(room.settings.game)) return { status: "room_full" };
  const used = new Set(room.players.filter((p) => p.kind === "cpu").map((p) => p.name));
  const number = [1, 2, 3].find((value) => !used.has(`CPU ${value}`));
  if (number === undefined) return { status: "room_full" };
  dependencies.appendSystem("joined", `CPU Lv${level}が入室しました`);
  return {
    status: "updated",
    room: roomSchema.parse({
      ...room,
      publicUpdatedAtMs: nextPublicUpdateAt(room),
      lastActivityAtMs: Date.now(),
      players: [
        ...room.players,
        {
          id: crypto.randomUUID(),
          name: `CPU ${number}`,
          kind: "cpu",
          level,
          ready: true,
          ...policy.waitingSeat,
          reconnectDeadline: null,
        },
      ],
    }),
  };
}

function updateCpu(
  dependencies: AdapterDependencies,
  policy: SettingsPolicy,
  room: Waiting,
  command: CpuCommand,
): SettingsResult {
  if (command.type === "room.cpu.add") return addCpu(dependencies, policy, room, command.level);
  const cpu = room.players.find((player) => player.id === command.playerId);
  if (cpu?.kind !== "cpu") return { status: "cpu_not_found" };
  if (command.type === "room.cpu.remove") {
    dependencies.recordDeparture(cpu);
    return {
      status: "updated",
      room: roomSchema.parse({
        ...room,
        publicUpdatedAtMs: nextPublicUpdateAt(room),
        lastActivityAtMs: Date.now(),
        players: room.players.filter((player) => player.id !== cpu.id),
      }),
    };
  }
  if (cpu.level === command.level) return { status: "unchanged" };
  return {
    status: "updated",
    room: roomSchema.parse({
      ...room,
      publicUpdatedAtMs: nextPublicUpdateAt(room),
      lastActivityAtMs: Date.now(),
      players: room.players.map((player) =>
        player.id === cpu.id ? { ...cpu, level: command.level } : player,
      ),
    }),
  };
}
