import type { ChatMessage } from "@tetraboard/protocol";
import { readMembership, readRoom } from "../../adapters/room/state";
import { broadcastChat, readChat } from "./chat";
import type { RoomRuntime } from "./runtime";
import { chatKey, mutedKey } from "./storageKeys";
import { hashMembershipToken } from "./tokenCrypto";
import { viewerMac } from "./viewerTokens";

export async function inspectReport(
  runtime: RoomRuntime,
  token: string,
  messageId: string,
): Promise<
  | { status: "found"; instanceId: string; message: ChatMessage; reporterHash: string }
  | { status: "not_found" | "unauthorized" | "message_not_found" }
> {
  await runtime.reconcileDeadlines();
  const room = readRoom(runtime);
  if (room === null) return { status: "not_found" };
  const tokenHash = await hashMembershipToken(token);
  const membership = readMembership(runtime, tokenHash);
  const isPlayer =
    membership !== null && room.players.some((player) => player.id === membership.playerId);
  const isViewer =
    token.length === 64 && (await viewerMac(runtime, token.slice(0, 32))) === token.slice(32);
  if (!isPlayer && !isViewer) return { status: "unauthorized" };
  const message = readChat(runtime).find((entry) => entry.id === messageId);
  if (message === undefined || message.kind !== "player") return { status: "message_not_found" };
  return { status: "found", instanceId: room.instanceId, message, reporterHash: tokenHash };
}

export async function moderateMessage(
  runtime: RoomRuntime,
  instanceId: string,
  messageId: string,
  senderId: string,
  remove: boolean,
  mute: boolean,
): Promise<"applied" | "room_changed"> {
  await runtime.reconcileDeadlines();
  const room = readRoom(runtime);
  if (room === null || room.instanceId !== instanceId) return "room_changed";
  runtime.ctx.storage.transactionSync(() => {
    if (remove)
      runtime.ctx.storage.kv.put(
        chatKey,
        readChat(runtime).filter((message) => message.id !== messageId),
      );
    if (mute)
      runtime.ctx.storage.kv.put(mutedKey, [
        ...new Set([...(runtime.ctx.storage.kv.get<string[]>(mutedKey) ?? []), senderId]),
      ]);
  });
  if (remove) broadcastChat(runtime);
  return "applied";
}
