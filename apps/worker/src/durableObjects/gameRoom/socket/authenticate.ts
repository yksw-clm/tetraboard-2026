import { roomSchema } from "@tetraboard/protocol";
import { currentRoomMembership, readRoom } from "../../../adapters/room/state";
import { withIndexTransaction } from "../../../adapters/room/transaction";
import { advanceMatchmakingStart } from "../../../flows/matchmakingRoom/start";
import { advanceTournamentStart } from "../../../flows/tournamentRoom/start";
import { roomStorageKey } from "../../../rooms/progressHelpers";
import type { RoomRuntime } from "../runtime";
import { broadcastRoom, sendSocketError } from "../snapshots";
import { disconnectedAtKey } from "../storageKeys";
import { authenticationMessage } from "./membership";

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
  const result = currentRoomMembership(runtime, tokenHash);
  if (result.status !== "found") {
    socket.serializeAttachment(null);
    sendSocketError(runtime, socket, result.status === "not_found" ? "not_found" : "unauthorized");
    return;
  }

  socket.serializeAttachment({ tokenHash });
  runtime.ctx.storage.kv.delete(disconnectedAtKey(result.membership.playerId));
  const room = readRoom(runtime);
  const player = room?.players.find((entry) => entry.id === result.membership.playerId);
  if (player !== undefined && player.reconnectDeadline !== null) {
    withIndexTransaction(runtime, () => {
      const current = readRoom(runtime);
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
  const connectedRoom = readRoom(runtime);
  if (connectedRoom !== null) broadcastRoom(runtime, connectedRoom);
  socket.send(JSON.stringify(authenticationMessage(runtime, socket, result.membership)));
  await advanceTournamentStart(runtime);
  await advanceMatchmakingStart(runtime);
}
