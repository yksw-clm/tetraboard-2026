import type { Room } from "@tetraboard/protocol";
import { releaseResultAvatars } from "./participants";
import { publishRoom, type RoomOperation } from "./ports";

type StartPreparation =
  | { status: "ready"; room: Extract<Room, { status: "waiting" }> }
  | {
      status:
        | "not_found"
        | "already_started"
        | "unauthorized"
        | "forbidden"
        | "registration_pending"
        | "not_ready";
    };
export function prepareStart(op: RoomOperation, hash: string): StartPreparation {
  const room = op.state.readRoom();
  if (room === null) return { status: "not_found" };
  if (room.status !== "waiting") return { status: "already_started" };
  const membership = op.state.membership(hash);
  if (membership === null) return { status: "unauthorized" };
  if (membership.role !== "host") return { status: "forbidden" };
  if (room.players.some((player) => op.state.hasRegistration(player.id)))
    return { status: "registration_pending" };
  if (
    room.players.length !== op.game(room).capacity ||
    room.players.some((player) => {
      if (player.kind === "cpu") return false;
      const token = op.state.playerToken(player.id);
      return !player.ready || token === null || !op.state.hasConnection(token);
    })
  )
    return { status: "not_ready" };
  return { status: "ready", room };
}

export function startGame(op: RoomOperation, room: Extract<Room, { status: "waiting" }>) {
  const started = op.game(room).start(room);
  releaseResultAvatars(op, room, new Set(started.room.players.map((player) => player.id)));
  op.effects.push(...op.state.startMatchUsage(started.roundId, started.room, started.at));
  publishRoom(op, started.room);
  return { status: "started" as const, room: started.room };
}
