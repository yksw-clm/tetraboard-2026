import type { Room, RoomMembership } from "@tetraboard/protocol";
import { createUuid } from "../../shared/createUuid";

// 作成成功から次の画面へ渡す意図だけを保持し、履歴・再読み込みから再演しません。
const pending = new Set<string>();

export function createRoomShareIntent(room: Room, membership: RoomMembership) {
  const roomShare = {
    roomId: room.id,
    instanceId: room.instanceId,
    playerId: membership.playerId,
    nonce: createUuid(),
  };
  pending.add(roomShare.nonce);
  return { roomShare };
}

export function canOpenCreatedRoomShare(
  state: unknown,
  room: Room,
  membership: RoomMembership | null,
): boolean {
  if (!state || typeof state !== "object" || !("roomShare" in state)) return false;
  const intent = state.roomShare;
  return Boolean(
    intent &&
    typeof intent === "object" &&
    "nonce" in intent &&
    typeof intent.nonce === "string" &&
    pending.has(intent.nonce) &&
    "roomId" in intent &&
    intent.roomId === room.id &&
    "instanceId" in intent &&
    intent.instanceId === room.instanceId &&
    "playerId" in intent &&
    intent.playerId === membership?.playerId &&
    membership?.role === "host",
  );
}

export function consumeRoomShareIntent(state: unknown): void {
  if (!state || typeof state !== "object" || !("roomShare" in state)) return;
  const intent = state.roomShare;
  if (intent && typeof intent === "object" && "nonce" in intent && typeof intent.nonce === "string")
    pending.delete(intent.nonce);
}
