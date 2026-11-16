import { declareShogi, play, resign, setShogiDrawProposal } from "../../../adapters/room/commands";
import { startGame } from "../../../adapters/room/startGame";
import type { ActionCommand } from "../../../rooms/gameAdapters/types";
import type { RoomRuntime, SocketCommand } from "../runtime";
import { rejectAction, sendRoomSnapshot } from "../snapshots";

export async function handleStart(
  runtime: RoomRuntime,
  socket: WebSocket,
  tokenHash: string,
): Promise<void> {
  const result = await startGame(runtime, tokenHash);
  if (result.status !== "started") rejectAction(runtime, socket, result.status);
}

export async function handleDrawOrDeclare(
  runtime: RoomRuntime,
  socket: WebSocket,
  command: SocketCommand<"room.game.draw.set" | "room.game.declare">,
  tokenHash: string,
): Promise<void> {
  const result =
    command.type === "room.game.declare"
      ? declareShogi(runtime, tokenHash, command)
      : setShogiDrawProposal(runtime, tokenHash, command);
  if (result.status === "updated") return;
  if (result.status === "unchanged") {
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
  const result = resign(runtime, tokenHash);
  if (result.status === "resigned") return;
  if (result.status === "time_expired") {
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
  const result = play(runtime, tokenHash, command);
  if (result.status === "placed") return;
  if (result.status === "time_expired") {
    await runtime.reconcileDeadlines();
    rejectAction(runtime, socket, result.status);
  } else rejectAction(runtime, socket, result.status);
}
