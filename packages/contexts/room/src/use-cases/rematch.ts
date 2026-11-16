import type { Room } from "@tetraboard/protocol";
import { closeRoom } from "./close";
import { recordDeparture } from "./participants";
import { reconnectGraceMs, type RoomOperation } from "./ports";
export function rematchPlayers<P extends Room["players"]>(
  op: RoomOperation,
  seats: P,
  at: number,
): P | null {
  const players = seats.filter((player) => {
    if (player.kind === "cpu") return true;
    if (!op.state.isHumanParticipant(player)) return false;
    const hash = op.state.playerToken(player.id);
    if (hash === null || op.state.membership(hash) === null) return false;
    if (op.state.hasConnection(hash)) return true;
    const disconnectedAt = op.state.disconnectedAt(player.id);
    return disconnectedAt !== undefined && disconnectedAt + reconnectGraceMs > at;
  });
  const humans = players.filter((player) => player.kind === "human");
  if (humans.length === 0) {
    closeRoom(op);
    return null;
  }
  for (const player of seats) {
    if (player.kind !== "human" || players.includes(player)) continue;
    recordDeparture(op, player);
    // 前局の結果が表示される間は、退室者の画像参照だけを保持します。
    op.state.releaseAccount(player.id, false);
    op.state.clearDeparted(player.id);
    const hash = op.state.playerToken(player.id);
    if (hash !== null) op.state.deleteMembership(hash);
    op.state.deletePlayerToken(player.id);
    op.state.clearPlayerTransientState(player.id);
  }
  const host = humans.find((player) => {
    const hash = op.state.playerToken(player.id);
    return hash !== null && op.state.membership(hash)?.role === "host";
  });
  const nextHost = host ?? humans[0];
  if (host === undefined) {
    const hash = op.state.playerToken(nextHost.id)!;
    op.state.saveMembership(hash, { playerId: nextHost.id, role: "host" });
  }
  const ordered = [nextHost, ...players.filter((player) => player.id !== nextHost.id)];
  for (const player of ordered) op.state.clearDeparted(player.id);
  return ordered.map((player) => ({
    ...player,
    ready: player.kind === "cpu",
    reconnectDeadline:
      player.kind === "cpu" || op.state.hasConnection(op.state.playerToken(player.id)!)
        ? null
        : op.state.disconnectedAt(player.id)! + reconnectGraceMs,
  })) as P;
}
