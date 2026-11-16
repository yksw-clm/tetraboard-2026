import type { Room } from "@tetraboard/protocol";
import { nextPublicUpdateAt, reconnectGraceMs, type RoomOperation } from "./ports";
import { closeRoom } from "./close";

export function processTournamentDeadline(op: RoomOperation, room: Room) {
  const tournament = op.state.waitingTournament(room);
  let changed = false;
  if (
    tournament &&
    room.status === "waiting" &&
    "tournamentStartsAtMs" in room &&
    room.tournamentStartsAtMs !== undefined &&
    !tournament.connected
  ) {
    const { tournamentStartsAtMs: _deadline, ...waiting } = room;
    room = op.state.saveRoom({
      ...waiting,
      publicUpdatedAtMs: nextPublicUpdateAt(room, op.now),
    } as Room);
    changed = true;
  }
  if (tournament && (op.now >= tournament.expiresAt || room.players.length !== 4)) {
    closeRoom(op, room);
    return { room: null, changed: true };
  }
  return { room, changed };
}

export function processRegistrationDeadlines(op: RoomOperation, room: Room, changed: boolean) {
  const players = room.players.map((player) => {
    if (player.kind !== "human") return player;
    let deadline = op.state.registrationDeadline(player.id);
    if (deadline !== undefined && deadline <= op.now) {
      op.state.expireRegistration(player.id);
      deadline = undefined;
      changed = true;
    }
    if (player.registrationPendingUntilMs === deadline) return player;
    changed = true;
    const { registrationPendingUntilMs: _pending, ...rest } = player;
    return deadline === undefined ? rest : { ...rest, registrationPendingUntilMs: deadline };
  });
  return { room: changed ? op.state.saveRoom({ ...room, players } as Room) : room, changed };
}

export function assignDisconnectDeadlines(op: RoomOperation, room: Room, changed: boolean) {
  const players = room.players.map((player) => {
    const hash = op.state.playerToken(player.id);
    if (
      !op.state.isHumanParticipant(player) ||
      player.reconnectDeadline !== null ||
      hash === null ||
      op.state.hasConnection(hash)
    )
      return player;
    const disconnectedAt = op.state.disconnectedAt(player.id) ?? op.now;
    op.state.saveDisconnectedAt(player.id, disconnectedAt);
    changed = true;
    return { ...player, reconnectDeadline: disconnectedAt + reconnectGraceMs };
  });
  return { room: changed ? op.state.saveRoom({ ...room, players } as Room) : room, changed };
}
