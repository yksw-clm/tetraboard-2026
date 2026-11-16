import type { Room, RoomSocketMessage } from "@tetraboard/protocol";
import type { ActionCommand, DeclareCommand, DrawCommand, SettingsCommand } from "./gamePort";
import { publishRoom, type RoomOperation } from "./ports";
import { applyProgress } from "./progress";

type GameActionResult<T extends string> =
  | { status: T; room: Room | null }
  | { status: Extract<RoomSocketMessage, { type: "room.error" }>["error"] };

export function play(
  op: RoomOperation,
  hash: string,
  command: ActionCommand,
): GameActionResult<"placed"> {
  const room = op.state.readRoom();
  if (!room) return { status: "not_found" };
  const result = op.game(room).play(room, hash, command);
  if (result.kind === "rejected") return { status: result.error };
  const updated = applyProgress(op, result);
  if (updated) op.state.saveRoom(updated);
  publishRoom(op, updated);
  return { status: "placed", room: updated };
}

export function setShogiDrawProposal(
  op: RoomOperation,
  hash: string,
  command: DrawCommand,
): GameActionResult<"updated" | "unchanged"> {
  const room = op.state.readRoom();
  if (!room) return { status: "not_found" };
  const result = op.game(room).draw(room, hash, command);
  if (result.kind === "rejected") return { status: result.error };
  if (result.kind === "unchanged") return { status: "unchanged", room: result.room };
  let updated = applyProgress(op, result);
  if (updated) updated = applyProgress(op, op.game(updated).afterDraw(updated));
  if (updated) op.state.saveRoom(updated);
  publishRoom(op, updated);
  return { status: "updated", room: updated };
}

export function declareShogi(
  op: RoomOperation,
  hash: string,
  command: DeclareCommand,
): GameActionResult<"updated"> {
  const room = op.state.readRoom();
  if (!room) return { status: "not_found" };
  const result = op.game(room).declare(room, hash, command);
  if (result.kind === "rejected") return { status: result.error };
  const updated = applyProgress(op, result);
  if (updated) op.state.saveRoom(updated);
  publishRoom(op, updated);
  return { status: "updated", room: updated };
}

export function resign(op: RoomOperation, hash: string): GameActionResult<"resigned"> {
  const room = op.state.readRoom();
  if (!room) return { status: "not_found" };
  const result = op.game(room).resign(room, hash);
  if (result.kind === "rejected") return { status: result.error };
  const updated = applyProgress(op, result);
  if (updated) op.state.saveRoom(updated);
  publishRoom(op, updated);
  return { status: "resigned", room: updated };
}

export function updateGameSettings(op: RoomOperation, hash: string, command: SettingsCommand) {
  const room = op.state.readRoom();
  if (!room) return { status: "not_found" as const };
  const result = op.game(room).settings(room, hash, command);
  if (result.status === "updated") {
    op.state.saveRoom(result.room);
    publishRoom(op, result.room);
  }
  return result;
}
