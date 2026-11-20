import {
  applySettings,
  setReady,
  setTimeControl,
  updateGameSettings,
} from "../../../adapters/room/commands";
import { readRoom } from "../../../adapters/room/state";
import type { SettingsCommand } from "../../../adapters/room/games/types";
import type { RoomRuntime, RoomUpdateResult, SocketCommand } from "../runtime";
import { rejectAction, sendRoomSnapshot } from "../snapshots";

function sendUpdate(runtime: RoomRuntime, socket: WebSocket, result: RoomUpdateResult): void {
  if (result.status === "updated") return;
  if (result.status === "unchanged") {
    const room = readRoom(runtime);
    if (room !== null) sendRoomSnapshot(runtime, socket, room);
  } else rejectAction(runtime, socket, result.status);
}

export function handleReady(
  runtime: RoomRuntime,
  socket: WebSocket,
  command: SocketCommand<"room.ready.set">,
  tokenHash: string,
): void {
  sendUpdate(runtime, socket, setReady(runtime, tokenHash, command.ready));
}

export function handleSettings(
  runtime: RoomRuntime,
  socket: WebSocket,
  command: SocketCommand<"room.settings.apply">,
  tokenHash: string,
): void {
  sendUpdate(runtime, socket, applySettings(runtime, tokenHash, command));
}

export function handleGameSettings(
  runtime: RoomRuntime,
  socket: WebSocket,
  command: SettingsCommand,
  tokenHash: string,
): void {
  sendUpdate(runtime, socket, updateGameSettings(runtime, tokenHash, command));
}

export function handleTimeControl(
  runtime: RoomRuntime,
  socket: WebSocket,
  command: SocketCommand<"room.time-control.set">,
  tokenHash: string,
): void {
  sendUpdate(runtime, socket, setTimeControl(runtime, tokenHash, command.timeControl));
}
