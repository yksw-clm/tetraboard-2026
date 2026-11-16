import type { Room, RoomMembership } from "@tetraboard/protocol";
import {
  appendSystem,
  nextPublicUpdateAt,
  reconnectGraceMs,
  type RoomAdmission,
  type RoomOperation,
} from "./ports";

type JoinResult =
  | { status: "joined"; room: Room; membership: RoomMembership }
  | {
      status:
        | "not_found"
        | "room_changed"
        | "matchmaking_required"
        | "tournament_required"
        | "room_started"
        | "room_full";
    };
export function joinRoom(
  op: RoomOperation,
  name: string,
  hash: string,
  playerId: string,
  instanceId?: string,
  admission?: RoomAdmission,
): JoinResult {
  const room = op.state.readRoom();
  if (room === null) return { status: "not_found" };
  if (instanceId !== undefined && room.instanceId !== instanceId) return { status: "room_changed" };
  if ("matchmaking" in room && room.matchmaking) return { status: "matchmaking_required" };
  if (
    (room.settings.game === "four-shogi" ||
      room.settings.game === "four-reversi" ||
      room.settings.game === "four-gomoku") &&
    "tournamentId" in room &&
    room.tournamentId !== undefined
  )
    return { status: "tournament_required" };
  if (room.status !== "waiting") return { status: "room_started" };
  if (room.players.length >= op.game(room).capacity) return { status: "room_full" };
  if (op.state.hasMembership(hash)) throw new Error("Membership token collision");
  if (admission && (room.instanceId !== admission.instanceId || name !== admission.name))
    throw new Error("Admission does not match room");
  const updatedRoom = {
    ...room,
    publicUpdatedAtMs: nextPublicUpdateAt(room, op.now),
    lastActivityAtMs: op.now,
    players: [
      ...room.players,
      {
        id: playerId,
        name,
        kind: "human",
        avatarUrl: admission?.avatarUrl ?? null,
        ...(admission?.isGuest ? { isGuest: true } : {}),
        ready: false,
        ...op.game(room).waitingSeat,
        reconnectDeadline: op.now + reconnectGraceMs,
      },
    ],
  } as Room;
  const membership: RoomMembership = { playerId, role: "player" };
  op.state.saveIdentity(playerId);
  const saved = op.state.saveRoom(updatedRoom);
  if (admission) op.state.saveAdmission(playerId);
  op.state.saveMembership(hash, membership);
  op.state.savePlayerToken(playerId, hash);
  op.state.saveDisconnectedAt(playerId, op.now);
  appendSystem(op, "joined", `${name}が入室しました`);
  op.effects.push({ type: "broadcastRoom", room: saved });
  return { status: "joined", room: saved, membership };
}
