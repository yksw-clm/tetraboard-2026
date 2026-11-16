import { releaseResultAvatars } from "./participants";
import type { RoomOperation } from "./ports";

export function closeRoom(op: RoomOperation, room = op.state.readRoom()): void {
  op.state.closeReservations(room);
  if (room) releaseResultAvatars(op, room, new Set());
  op.effects.push(...op.state.endMatchUsage("abandoned", op.now));
  for (const player of room?.players ?? []) {
    op.state.deleteIdentity(player.id);
    if (player.kind !== "human") continue;
    op.state.releaseRegistration(player.id);
    op.state.releaseAccount(player.id, true);
    const tokenHash = op.state.playerToken(player.id);
    if (tokenHash !== null) op.state.deleteMembership(tokenHash);
    op.state.deletePlayerToken(player.id);
    op.state.clearClosedPlayerState(player.id);
  }
  op.state.clearRoom();
  if (room) op.game(room).close();
}
