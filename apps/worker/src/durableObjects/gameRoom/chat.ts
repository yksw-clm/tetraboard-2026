import {
  chatEntrySchema,
  chatHistoryLimit,
  chatMessageSchema,
  chatTextSchema,
  roomInteractionIntervalMs,
  roomSchema,
  roomSocketContract,
  systemChatMessageSchema,
  type ChatEntry,
  type RoomSocketMessage,
  type SystemChatMessage,
} from "@tetraboard/protocol";
import { isHumanParticipant, readMembership } from "../../adapters/room/state";
import { withIndexTransaction } from "../../adapters/room/transaction";
import { roomStorageKey } from "../../rooms/progressHelpers";
import type { RoomRuntime } from "./runtime";
import { chatKey, lastChatAtKey, mutedKey } from "./storageKeys";

export function readChat(runtime: RoomRuntime): ChatEntry[] {
  return (runtime.ctx.storage.kv.get<unknown[]>(chatKey) ?? []).map((entry) =>
    chatEntrySchema.parse(entry),
  );
}

export function appendSystem(
  runtime: RoomRuntime,
  event: SystemChatMessage["event"],
  text: string,
  at = Date.now(),
  markDirty = true,
): void {
  const message = systemChatMessageSchema.parse({
    id: crypto.randomUUID(),
    kind: "system",
    event,
    text,
    sentAtMs: at,
  });
  runtime.ctx.storage.kv.put(chatKey, [...readChat(runtime), message].slice(-chatHistoryLimit));
  if (markDirty) runtime.chat.dirty = true;
}

export function chatSnapshot(runtime: RoomRuntime): RoomSocketMessage {
  return roomSocketContract.message.parse({
    type: "room.chat.snapshot",
    messages: readChat(runtime),
  });
}

export function broadcastChat(runtime: RoomRuntime): void {
  runtime.chat.dirty = false;
  const payload = JSON.stringify(chatSnapshot(runtime));
  for (const socket of runtime.ctx.getWebSockets()) {
    if (socket.readyState !== WebSocket.OPEN) continue;
    try {
      socket.send(payload);
    } catch {
      // 切断中の相手への配信失敗で、保存済みの投稿や操作を失敗にしません。
    }
  }
}

export function sendChat(
  runtime: RoomRuntime,
  tokenHash: string,
  rawText: string,
): "sent" | "unauthorized" | "rate_limited" | "muted" | "invalid_request" {
  const parsed = chatTextSchema.safeParse(rawText);
  if (!parsed.success) return "invalid_request";
  return withIndexTransaction(runtime, (room) => {
    const membership = readMembership(runtime, tokenHash);
    if (room === null || membership === null) return "unauthorized";
    const player = room.players.find((entry) => entry.id === membership.playerId);
    if (!player || !isHumanParticipant(runtime, player)) return "unauthorized";
    if ((runtime.ctx.storage.kv.get<string[]>(mutedKey) ?? []).includes(player.id)) return "muted";
    const now = Date.now();
    if (
      now - (runtime.ctx.storage.kv.get<number>(lastChatAtKey(player.id)) ?? -Infinity) <
      roomInteractionIntervalMs
    )
      return "rate_limited";
    const message = chatMessageSchema.parse({
      id: crypto.randomUUID(),
      senderId: player.id,
      senderName: player.name,
      text: parsed.data,
      sentAtMs: now,
    });
    runtime.ctx.storage.kv.put(chatKey, [...readChat(runtime), message].slice(-chatHistoryLimit));
    runtime.ctx.storage.kv.put(lastChatAtKey(player.id), now);
    runtime.ctx.storage.kv.put(
      roomStorageKey,
      roomSchema.parse({ ...room, lastActivityAtMs: now }),
    );
    return "sent";
  });
}
