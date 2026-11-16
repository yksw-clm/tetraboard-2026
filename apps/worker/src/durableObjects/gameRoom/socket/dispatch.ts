import type { RoomSocketClientMessage } from "@tetraboard/protocol";
import { unreachable } from "../../../rooms/gameProgress";
import type { RoomRuntime } from "../runtime";
import { authenticate } from "./authenticate";
import { handleChat, handleStamp } from "./interactions";
import { handleReady, handleSettings, handleGameSettings, handleTimeControl } from "./settings";
import { handleStart, handleDrawOrDeclare, handleResign, handleAction } from "./game";

export async function dispatchMessage(
  runtime: RoomRuntime,
  socket: WebSocket,
  command: RoomSocketClientMessage,
  tokenHash: string | null,
): Promise<void> {
  switch (command.type) {
    case "room.auth":
      return authenticate(runtime, socket, tokenHash!);
    case "room.stamp.send":
      return handleStamp(runtime, socket, command, tokenHash);
    case "room.chat.send":
      return handleChat(runtime, socket, command, tokenHash!);
    case "room.ready.set":
      return handleReady(runtime, socket, command, tokenHash!);
    case "room.settings.apply":
      return handleSettings(runtime, socket, command, tokenHash!);
    case "room.gomoku-forbidden.set":
    case "room.three-player-attack.set":
    case "room.mode.set":
    case "room.cpu.add":
    case "room.cpu.remove":
    case "room.cpu.level.set":
      return handleGameSettings(runtime, socket, command, tokenHash!);
    case "room.time-control.set":
      return handleTimeControl(runtime, socket, command, tokenHash!);
    case "room.game.start":
      return handleStart(runtime, socket, tokenHash!);
    case "room.game.draw.set":
    case "room.game.declare":
      return handleDrawOrDeclare(runtime, socket, command, tokenHash!);
    case "room.game.resign":
      return handleResign(runtime, socket, tokenHash!);
    case "room.game.action":
      return handleAction(runtime, socket, command, tokenHash!);
    default:
      return unreachable(command);
  }
}
