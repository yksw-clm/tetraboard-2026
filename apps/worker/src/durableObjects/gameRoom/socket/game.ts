import type { ActionCommand } from "../../../rooms/gameAdapters/types";
import type { RoomRuntime, SocketCommand } from "../runtime";
import { broadcastRoom, sendRoomSnapshot, rejectAction } from "../snapshots";
import { closeSockets } from "../connections";

export async function handleStart(
  runtime: RoomRuntime,
  socket: WebSocket,
  tokenHash: string,
): Promise<void> {
  const result = await runtime.startGame(tokenHash);
  if (result.status === "started") broadcastRoom(runtime, result.room);
  else rejectAction(runtime, socket, result.status);
}

export async function handleDrawOrDeclare(
  runtime: RoomRuntime,
  socket: WebSocket,
  command: SocketCommand<"room.game.draw.set" | "room.game.declare">,
  tokenHash: string,
): Promise<void> {
  const result =
    command.type === "room.game.declare"
      ? runtime.declareShogi(tokenHash, command)
      : runtime.setShogiDrawProposal(tokenHash, command);
  if (result.status === "updated") {
    if (result.room === null) closeSockets(runtime);
    else broadcastRoom(runtime, result.room);
  } else if (result.status === "unchanged") {
    if (result.room) sendRoomSnapshot(runtime, socket, result.room);
  } else if (result.status === "time_expired") {
    await runtime.reconcileDeadlines();
    rejectAction(runtime, socket, result.status);
  } else rejectAction(runtime, socket, result.status);
}

export async function handleResign(
  runtime: RoomRuntime,
  socket: WebSocket,
  tokenHash: string,
): Promise<void> {
  const result = runtime.resign(tokenHash);
  if (result.status === "resigned") {
    if (result.room === null) closeSockets(runtime);
    else broadcastRoom(runtime, result.room);
  } else if (result.status === "time_expired") {
    await runtime.reconcileDeadlines();
    rejectAction(runtime, socket, result.status);
  } else rejectAction(runtime, socket, result.status);
}

export async function handleAction(
  runtime: RoomRuntime,
  socket: WebSocket,
  command: ActionCommand,
  tokenHash: string,
): Promise<void> {
  const result = runtime.play(tokenHash, command);
  if (result.status === "placed") {
    if (result.room === null) closeSockets(runtime);
    else broadcastRoom(runtime, result.room);
  } else if (result.status === "time_expired") {
    await runtime.reconcileDeadlines();
    rejectAction(runtime, socket, result.status);
  } else rejectAction(runtime, socket, result.status);
}
