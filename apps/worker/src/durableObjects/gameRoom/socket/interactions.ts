import { roomSocketContract } from "@tetraboard/protocol";
import type { RoomRuntime, SocketCommand } from "../runtime";
import { sendChat, broadcastChat } from "../chat";
import { sendStamp, broadcastStamp } from "../stamps";
import { stampTag } from "../storageKeys";
import { sendSocketError } from "../snapshots";

export function handleChat(
  runtime: RoomRuntime,
  socket: WebSocket,
  command: SocketCommand<"room.chat.send">,
  tokenHash: string,
): void {
  const status = sendChat(runtime, tokenHash, command.text);
  if (status === "sent") broadcastChat(runtime);
  else
    socket.send(
      JSON.stringify(roomSocketContract.message.parse({ type: "room.chat.error", error: status })),
    );
}

export function handleStamp(
  runtime: RoomRuntime,
  socket: WebSocket,
  command: SocketCommand<"room.stamp.send">,
  tokenHash: string | null,
): void {
  if (!runtime.ctx.getTags(socket).includes(stampTag)) {
    sendSocketError(runtime, socket, "invalid_request");
    return;
  }
  const result =
    tokenHash !== null
      ? sendStamp(runtime, tokenHash, command)
      : { status: "unauthorized" as const };
  if (result.status === "sent") broadcastStamp(runtime, result.notification);
  else
    socket.send(
      JSON.stringify(
        roomSocketContract.message.parse({
          type: "room.stamp.error",
          requestId: command.requestId,
          error: result.status,
          ...("interactionAvailableAtMs" in result
            ? { interactionAvailableAtMs: result.interactionAvailableAtMs }
            : {}),
        }),
      ),
    );
}
