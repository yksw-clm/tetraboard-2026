import type { Room } from "@tetraboard/protocol";
import { appendSystem, reconnectGraceMs, type RoomAdmission, type RoomOperation } from "./ports";

function checkAdmission(room: Room, admission: RoomAdmission): void {
  const host = room.players[0];
  if (
    room.instanceId !== admission.instanceId ||
    host.id !== admission.playerId ||
    host.name !== admission.name ||
    host.kind !== "human" ||
    host.avatarUrl !== admission.avatarUrl
  )
    throw new Error("Admission does not match host");
}

export function createRoom(
  op: RoomOperation,
  initialRoom: Room,
  hash: string,
  viewerSecret: string,
  admission?: RoomAdmission,
): Room | null {
  if (op.state.hasRoom() || op.state.hasMembership(hash)) return null;
  const pendingRoom = {
    ...initialRoom,
    players: initialRoom.players.map((player) =>
      player.kind === "human"
        ? { ...player, reconnectDeadline: op.now + reconnectGraceMs }
        : player,
    ),
  } as Room;
  if (admission) {
    checkAdmission(initialRoom, admission);
    op.state.saveAdmission(admission.playerId);
  }
  const hostId = initialRoom.players[0].id;
  op.state.saveIdentity(hostId);
  const saved = op.state.saveRoom(pendingRoom);
  op.state.initializeRoom(viewerSecret);
  op.state.saveMembership(hash, { playerId: hostId, role: "host" });
  op.state.savePlayerToken(hostId, hash);
  op.state.saveDisconnectedAt(hostId, op.now);
  for (const player of initialRoom.players)
    appendSystem(op, "joined", `${op.state.playerLabel(player)}が入室しました`);
  return saved;
}
