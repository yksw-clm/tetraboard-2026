import { roomSchema } from "@tetraboard/protocol";
import { roomStorageKey } from "../../../rooms/progressHelpers";
import { disconnectedAtKey } from "../storageKeys";
import { broadcastRoom, sendSocketError } from "../snapshots";
import { authenticationMessage } from "./membership";
import type { RoomRuntime } from "../runtime";

export async function authenticate(
  runtime: RoomRuntime,
  socket: WebSocket,
  tokenHash: string,
): Promise<void> {
  const existing: unknown = socket.deserializeAttachment();
  if (
    typeof existing === "object" &&
    existing !== null &&
    "tokenHash" in existing &&
    existing.tokenHash !== tokenHash
  ) {
    sendSocketError(runtime, socket, "unauthorized");
    return;
  }
  const result = runtime.currentRoomMembership(tokenHash);
  if (result.status !== "found") {
    socket.serializeAttachment(null);
    sendSocketError(runtime, socket, result.status === "not_found" ? "not_found" : "unauthorized");
    return;
  }

  socket.serializeAttachment({ tokenHash });
  runtime.ctx.storage.kv.delete(disconnectedAtKey(result.membership.playerId));
  const room = runtime.readRoom();
  const player = room?.players.find((entry) => entry.id === result.membership.playerId);
  if (player !== undefined && player.reconnectDeadline !== null) {
    runtime.withIndexTransaction(() => {
      const current = runtime.readRoom();
      if (current === null) return null;
      const next = roomSchema.parse({
        ...current,
        players: current.players.map((entry) =>
          entry.id === player.id ? { ...entry, reconnectDeadline: null } : entry,
        ),
      });
      runtime.ctx.storage.kv.put(roomStorageKey, next);
      return next;
    });
  }
  const connectedRoom = runtime.readRoom();
  if (connectedRoom !== null) broadcastRoom(runtime, connectedRoom);
  socket.send(JSON.stringify(authenticationMessage(runtime, socket, result.membership)));
  await runtime.advanceTournamentStart();
  await runtime.advanceMatchmakingStart();
}
