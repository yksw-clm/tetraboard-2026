import type { SettingsCommand } from "../../../rooms/gameAdapters/types";
import type { RoomRuntime, RoomUpdateResult, SocketCommand } from "../runtime";
import { broadcastRoom, sendRoomSnapshot, rejectAction } from "../snapshots";

function sendUpdate(runtime: RoomRuntime, socket: WebSocket, result: RoomUpdateResult): void {
  if (result.status === "updated") broadcastRoom(runtime, result.room);
  else if (result.status === "unchanged") {
    const room = runtime.readRoom();
    if (room !== null) sendRoomSnapshot(runtime, socket, room);
  } else rejectAction(runtime, socket, result.status);
}

export function handleReady(
  runtime: RoomRuntime,
  socket: WebSocket,
  command: SocketCommand<"room.ready.set">,
  tokenHash: string,
): void {
  sendUpdate(runtime, socket, runtime.setReady(tokenHash, command.ready));
}

export function handleSettings(
  runtime: RoomRuntime,
  socket: WebSocket,
  command: SocketCommand<"room.settings.apply">,
  tokenHash: string,
): void {
  sendUpdate(runtime, socket, runtime.applySettings(tokenHash, command));
}

export function handleGameSettings(
  runtime: RoomRuntime,
  socket: WebSocket,
  command: SettingsCommand,
  tokenHash: string,
): void {
  sendUpdate(runtime, socket, runtime.updateGameSettings(tokenHash, command));
}

export function handleTimeControl(
  runtime: RoomRuntime,
  socket: WebSocket,
  command: SocketCommand<"room.time-control.set">,
  tokenHash: string,
): void {
  sendUpdate(runtime, socket, runtime.setTimeControl(tokenHash, command.timeControl));
}
