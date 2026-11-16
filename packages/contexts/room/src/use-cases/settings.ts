import type { Room, RoomSocketClientMessage, RoomTimeControl } from "@tetraboard/protocol";
import { recordDeparture } from "./participants";
import { publishRoom, appendSystem, nextPublicUpdateAt, type RoomOperation } from "./ports";

type UpdateResult =
  | { status: "updated"; room: Room }
  | {
      status:
        | "unchanged"
        | "not_found"
        | "unauthorized"
        | "registration_pending"
        | "already_started";
    };
export function setReady(op: RoomOperation, hash: string, ready: boolean): UpdateResult {
  const room = op.state.readRoom();
  if (room === null) return { status: "not_found" };
  if (room.status !== "waiting") return { status: "already_started" };
  const membership = op.state.membership(hash);
  if (membership === null) return { status: "unauthorized" };
  const player = room.players.find((entry) => entry.id === membership.playerId);
  if (player === undefined) return { status: "unauthorized" };
  if (op.state.hasRegistration(player.id)) return { status: "registration_pending" };
  if (player.ready === ready) return { status: "unchanged" };
  const updatedRoom = op.state.saveRoom({
    ...room,
    lastActivityAtMs: op.now,
    players: room.players.map((entry) => (entry.id === player.id ? { ...entry, ready } : entry)),
  } as Room);
  publishRoom(op, updatedRoom);
  return { status: "updated", room: updatedRoom };
}

export function applySettings(
  op: RoomOperation,
  hash: string,
  command: Extract<RoomSocketClientMessage, { type: "room.settings.apply" }>,
) {
  const room = op.state.readRoom();
  if (!room) return { status: "not_found" as const };
  if (op.state.membership(hash)?.role !== "host") return { status: "forbidden" as const };
  const result = op.game(room).prepareSettings(room, command, op.now);
  if (result.status !== "updated") return result;
  if (command.mode !== undefined && command.mode !== room.settings.mode)
    appendSystem(
      op,
      "mode_changed",
      `対局形式が${command.mode === "singles" ? "シングルス" : "ダブルス"}に変更されました`,
    );
  for (const player of room.players)
    if (player.kind === "cpu" && !result.room.players.some((current) => current.id === player.id))
      recordDeparture(op, player, room);
  for (const player of result.room.players)
    if (player.kind === "cpu" && !room.players.some((previous) => previous.id === player.id))
      appendSystem(op, "joined", `CPU Lv${player.level}が入室しました`);
  op.state.saveRoom(result.room);
  publishRoom(op, result.room);
  return result;
}

export function setTimeControl(
  op: RoomOperation,
  hash: string,
  timeControl: RoomTimeControl,
):
  | { status: "updated"; room: Room }
  | { status: "unchanged" | "not_found" | "forbidden" | "already_started" } {
  const room = op.state.readRoom();
  if (!room) return { status: "not_found" };
  if (room.status !== "waiting") return { status: "already_started" };
  if (op.state.membership(hash)?.role !== "host") return { status: "forbidden" };
  if (
    room.settings.timeControl.mainTimeMs === timeControl.mainTimeMs &&
    room.settings.timeControl.byoyomiMs === timeControl.byoyomiMs
  )
    return { status: "unchanged" };
  const updated = op.state.saveRoom({
    ...room,
    settings: { ...room.settings, timeControl },
    players: room.players.map((player) =>
      player.kind === "human" ? { ...player, ready: false } : player,
    ),
    lastActivityAtMs: op.now,
    publicUpdatedAtMs: nextPublicUpdateAt(room, op.now),
  } as Room);
  publishRoom(op, updated);
  return { status: "updated", room: updated };
}
