import type { Room } from "@tetraboard/protocol";
import { closeRoom } from "./close";
import { appendSystem, type RoomOperation } from "./ports";
export function closeIfNoHumanParticipants<T extends Room>(
  op: RoomOperation,
  room: T | null,
): T | null {
  if (
    room === null ||
    op.game(room).keepsPlayingWithoutHumans(room) ||
    room.players.some((player) => op.state.isHumanParticipant(player))
  )
    return room;
  closeRoom(op);
  return null;
}

export function recordDeparture(op: RoomOperation, player: Room["players"][number]): void {
  if (op.state.hasDeparted(player.id)) return;
  op.state.deleteIdentity(player.id);
  if (op.state.readRoom()?.status === "playing") op.state.saveDeparted(player.id);
  appendSystem(op, "left", `${op.state.playerLabel(player)}が退室しました`);
}

export function releaseResultAvatars(
  op: RoomOperation,
  room: Room,
  retainedIds: Set<string>,
): void {
  for (const player of room.lastRound?.players ?? []) {
    if (!retainedIds.has(player.id)) op.state.releaseAccount(player.id, true);
  }
}
