import type { Room } from "@tetraboard/protocol";
import { closeRoom } from "./close";
import { closeIfNoHumanParticipants, recordDeparture } from "./participants";
import type { RoomOperation } from "./ports";
import { applyProgress } from "./progress";
import { removeWaitingPlayer } from "./removeWaitingPlayer";

type LeaveResult = {
  status: "not_found" | "unauthorized" | "time_expired" | "left";
  room: Room | null;
};
export function leaveRoom(op: RoomOperation, hash: string): LeaveResult {
  const room = op.state.readRoom();
  if (room === null) return { status: "not_found", room: null };
  if (room.status === "playing" && op.now >= room.clock.turnExpiresAt)
    return { status: "time_expired", room };
  const membership = op.state.membership(hash);
  if (membership === null) return { status: "unauthorized", room };
  const player = room.players.find((entry) => entry.id === membership.playerId);
  if (player === undefined) return { status: "unauthorized", room };
  let promoted: string | null = null;
  let updated: Room | null;
  if (room.status === "waiting") {
    if (op.state.excludeWaitingTournamentPlayer(room, player.id)) {
      closeRoom(op, room);
      op.effects.push({ type: "closeSockets" }, { type: "closeSockets", tokenHash: hash });
      return { status: "left", room: null };
    }
    const hostLeaving = room.players[0].id === player.id;
    updated = removeWaitingPlayer(op, room, player.id);
    if (hostLeaving && updated !== null) promoted = op.state.playerToken(updated.players[0].id);
  } else {
    recordDeparture(op, player, room);
    op.state.releaseAccount(player.id, false);
    const adapter = op.game(room);
    const leave = adapter.prepareLeave(room, player.id);
    op.state.deleteMembership(hash);
    op.state.deletePlayerToken(player.id);
    updated = applyProgress(op, leave(op.now, membership.role === "host"));
    if (updated) {
      updated = adapter.afterLeave(updated, room, op.now, membership.role === "host");
      op.state.saveRoom(updated);
    }
  }
  updated = closeIfNoHumanParticipants(op, updated);
  op.effects.push(
    updated === null ? { type: "closeSockets" } : { type: "broadcastRoom", room: updated },
  );
  if (promoted !== null) op.effects.push({ type: "sendMembership", tokenHash: promoted });
  op.effects.push({ type: "closeSockets", tokenHash: hash });
  return { status: "left", room: updated };
}
