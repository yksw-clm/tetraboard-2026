import type { Room } from "@tetraboard/protocol";
import { closeRoom } from "./close";
import { recordDeparture } from "./participants";
import { nextPublicUpdateAt, type RoomOperation } from "./ports";
export function removeWaitingPlayer(
  op: RoomOperation,
  room: Extract<Room, { status: "waiting" }>,
  playerId: string,
): Room | null {
  op.state.releaseRegistration(playerId);
  const departing = room.players.find((player) => player.id === playerId);
  if (departing) recordDeparture(op, departing, room);
  op.state.releaseAccount(
    playerId,
    !room.lastRound?.players.some((player) => player.id === playerId),
  );
  const tokenHash = op.state.playerToken(playerId);
  if (tokenHash !== null) op.state.deleteMembership(tokenHash);
  op.state.deletePlayerToken(playerId);

  let remaining = room.players.filter((player) => player.id !== playerId);
  const successor = remaining.find((player) => player.kind === "human");
  if (successor === undefined) {
    closeRoom(op, room);
    return null;
  }

  if (room.players[0].id === playerId) {
    remaining = [successor, ...remaining.filter((player) => player.id !== successor.id)];
    const nextHash = op.state.playerToken(successor.id);
    if (nextHash === null) throw new Error("Host successor has no membership");
    op.state.saveMembership(nextHash, { playerId: remaining[0].id, role: "host" });
  }
  const updated = op.state.saveRoom({
    ...room,
    publicUpdatedAtMs: nextPublicUpdateAt(room, op.now),
    lastActivityAtMs: op.now,
    players: remaining,
  } as Room);
  return updated;
}
