import {
  roomSocketContract,
  type RoomMembership,
  type RoomSocketMessage,
} from "@tetraboard/protocol";
import { publicMembership, readMembership } from "../../../adapters/room/state";
import type { RoomRuntime } from "../runtime";
import { interactionAvailableAtMs } from "../stamps";
import { stampTag } from "../storageKeys";

export function hasOpenConnection(
  runtime: RoomRuntime,
  tokenHash: string,
  excluded?: WebSocket,
): boolean {
  return runtime.ctx.getWebSockets().some((socket) => {
    if (socket === excluded || socket.readyState !== WebSocket.OPEN) return false;
    const attachment: unknown = socket.deserializeAttachment();
    return (
      typeof attachment === "object" &&
      attachment !== null &&
      "tokenHash" in attachment &&
      attachment.tokenHash === tokenHash
    );
  });
}

export function authenticationMessage(
  runtime: RoomRuntime,
  socket: WebSocket,
  membership: RoomMembership,
): RoomSocketMessage {
  return roomSocketContract.message.parse({
    type: "room.authenticated",
    membership: publicMembership(runtime, membership),
    ...(runtime.ctx.getTags(socket).includes(stampTag)
      ? { interactionAvailableAtMs: interactionAvailableAtMs(runtime, membership.playerId) }
      : {}),
  });
}

export function sendCurrentMembership(runtime: RoomRuntime, tokenHash: string): void {
  const membership = readMembership(runtime, tokenHash);
  if (membership === null) return;
  for (const socket of runtime.ctx.getWebSockets()) {
    if (socket.readyState !== WebSocket.OPEN) continue;
    const attachment: unknown = socket.deserializeAttachment();
    if (
      typeof attachment === "object" &&
      attachment !== null &&
      "tokenHash" in attachment &&
      attachment.tokenHash === tokenHash
    ) {
      socket.send(JSON.stringify(authenticationMessage(runtime, socket, membership)));
    }
  }
}
