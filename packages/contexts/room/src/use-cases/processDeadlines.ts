import type { Room } from "@tetraboard/protocol";
import type { RoomEffect } from "./effects";
import type { RoomOperation } from "./ports";
import { closeRoom } from "./close";
import { closeIfNoHumanParticipants, recordDeparture } from "./participants";
import { applyProgress } from "./progress";
import { removeWaitingPlayer } from "./removeWaitingPlayer";
import { nextDueRoomDeadline, type DueRoomDeadline } from "./dueDeadline";
import {
  assignDisconnectDeadlines,
  processRegistrationDeadlines,
  processTournamentDeadline,
} from "./deadlinePlayers";

export const roomIdleMs = 24 * 60 * 60 * 1000;
export const cpuMoveDelayMs = 2000;
export type ProcessDeadlinesResult = {
  room: Room | null;
  changed: boolean;
  external?: unknown;
  afterTransaction?(): void;
  notifications: RoomEffect[];
};

function applyDeadline(
  op: RoomOperation,
  room: Room,
  deadline: DueRoomDeadline,
  promoted: string[],
) {
  if (room.status === "playing" && deadline.type === "timeout")
    return applyProgress(op, op.game(room).cpu.timeout(room, deadline.at));
  if (deadline.type !== "disconnect") return room;
  const player = room.players.find((p) => p.id === deadline.playerId);
  if (!player) throw new Error("Deadline player is missing");
  if (room.status === "waiting") {
    const wasHost = room.players[0].id === player.id;
    const updated = removeWaitingPlayer(op, room, player.id);
    if (wasHost && updated) {
      const hash = op.state.playerToken(updated.players[0].id);
      if (hash) promoted.push(hash);
    }
    return updated;
  }
  recordDeparture(op, player, room);
  op.state.releaseAccount(player.id, false);
  return applyProgress(op, op.game(room).cpu.disconnect(room, player.id, deadline.at));
}

function dueDeadlines(op: RoomOperation, initial: Room, promoted: string[]) {
  let room: Room | null = initial;
  let changed = false;
  while (room) {
    const deadline = nextDueRoomDeadline(
      room.status === "playing" ? room.clock.turnExpiresAt : null,
      room.players,
      op.now,
    );
    if (!deadline) break;
    room = closeIfNoHumanParticipants(op, applyDeadline(op, room, deadline, promoted));
    changed = true;
    if (room) room = op.state.saveRoom(room);
  }
  const retained = closeIfNoHumanParticipants(op, room);
  return { room: retained, changed: changed || retained !== room };
}

function stepCpu(op: RoomOperation, room: Room | null, applyCpu: boolean) {
  let changed = false;
  if (
    room?.status !== "playing" ||
    !applyCpu ||
    room.clock.turnStartedAt + cpuMoveDelayMs > op.now ||
    op.now >= room.clock.turnExpiresAt
  )
    return { room, changed };
  const result = op.game(room).cpu.step(room, {
    now: op.now,
    hasCapacity: (current) => op.state.hasCpuCapacity(current),
    applyProgress: (progress) => {
      const current = applyProgress(op, progress);
      const saved = current ? op.state.saveRoom(current) : null;
      changed = true;
      return saved;
    },
  });
  return { ...result, changed };
}

export function processDeadlines(
  op: RoomOperation,
  initial: Room | null,
  applyCpu = false,
): ProcessDeadlinesResult {
  const promoted: string[] = [];
  if (!initial) return { room: null, changed: false, notifications: [] };
  const tournament = processTournamentDeadline(op, initial);
  let { room, changed } = tournament;
  if (room) {
    const idle =
      op.game(room).cpu.usesIdleDeadline(room) && room.lastActivityAtMs + roomIdleMs <= op.now;
    if (idle || closeIfNoHumanParticipants(op, room) === null) {
      if (idle) closeRoom(op, room);
      room = null;
      changed = true;
    }
  }
  if (room) {
    const registrations = processRegistrationDeadlines(op, room, changed);
    const disconnected = assignDisconnectDeadlines(op, registrations.room, registrations.changed);
    const due = dueDeadlines(op, disconnected.room, promoted);
    room = due.room;
    changed = disconnected.changed || due.changed;
  }
  const cpu = stepCpu(op, room, applyCpu);
  changed ||= cpu.changed;
  const notifications: RoomEffect[] = changed
    ? [cpu.room ? { type: "broadcastRoom", room: cpu.room } : { type: "closeSockets" }]
    : [];
  notifications.push(
    ...promoted.map((tokenHash) => ({ type: "sendMembership" as const, tokenHash })),
  );
  return { ...cpu, changed, notifications };
}
