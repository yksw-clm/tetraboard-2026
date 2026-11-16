import {
  roomInteractionIntervalMs,
  roomSchema,
  roomSocketContract,
  type RoomSocketClientMessage,
  type RoomStampNotification,
  type Room,
} from "@tetraboard/protocol";
import { roomStorageKey } from "../../rooms/progressHelpers";
import { lastChatAtKey, mutedKey, stampTag } from "./storageKeys";
import type { RoomRuntime } from "./runtime";

export function interactionAvailableAtMs(runtime: RoomRuntime, playerId: string): number {
  const at = runtime.ctx.storage.kv.get<number>(lastChatAtKey(playerId));
  return at === undefined ? 0 : at + roomInteractionIntervalMs;
}

export function sendStamp(
  runtime: RoomRuntime,
  tokenHash: string,
  command: Extract<RoomSocketClientMessage, { type: "room.stamp.send" }>,
):
  | { status: "sent"; notification: RoomStampNotification; room: Room }
  | { status: "unauthorized" | "muted" | "room_changed" }
  | { status: "rate_limited"; interactionAvailableAtMs: number } {
  return runtime.withIndexTransaction(() => {
    const room = runtime.readRoom();
    const membership = runtime.readMembership(tokenHash);
    if (!room || !membership) return { status: "unauthorized" };
    if (room.instanceId !== command.instanceId) return { status: "room_changed" };
    const player = room.players.find((entry) => entry.id === membership.playerId);
    if (!player || !runtime.isHumanParticipant(player)) return { status: "unauthorized" };
    if ((runtime.ctx.storage.kv.get<string[]>(mutedKey) ?? []).includes(player.id))
      return { status: "muted" };
    const now = Date.now();
    const availableAtMs = interactionAvailableAtMs(runtime, player.id);
    if (now < availableAtMs)
      return { status: "rate_limited", interactionAvailableAtMs: availableAtMs };
    const updated = roomSchema.parse({ ...room, lastActivityAtMs: now });
    const notification: RoomStampNotification = {
      type: "room.stamp.received",
      id: crypto.randomUUID(),
      instanceId: room.instanceId,
      requestId: command.requestId,
      senderId: player.id,
      stampId: command.stampId,
      sentAtMs: now,
    };
    runtime.ctx.storage.kv.put(lastChatAtKey(player.id), now);
    runtime.ctx.storage.kv.put(roomStorageKey, updated);
    return { status: "sent", notification, room: updated };
  });
}

export function broadcastStamp(runtime: RoomRuntime, notification: RoomStampNotification): void {
  const payload = JSON.stringify(roomSocketContract.message.parse(notification));
  for (const socket of runtime.ctx.getWebSockets(stampTag)) {
    if (socket.readyState !== WebSocket.OPEN) continue;
    try {
      socket.send(payload);
    } catch {
      /* 切断中の相手には再送しません。 */
    }
  }
}
