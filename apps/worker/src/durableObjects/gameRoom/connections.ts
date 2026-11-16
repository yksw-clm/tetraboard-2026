import { roomSchema } from "@tetraboard/protocol";
import { isHumanParticipant, readMembership, readRoom } from "../../adapters/room/state";
import { withIndexTransaction } from "../../adapters/room/transaction";
import { roomStorageKey } from "../../rooms/progressHelpers";
import { tournamentReturnKey, type TournamentReturn } from "../../rooms/tournamentRoom";
import type { RoomRuntime } from "./runtime";
import { broadcastRoom, sendSocketError } from "./snapshots";
import { hasOpenConnection } from "./socket/membership";
import { disconnectedAtKey, reconnectGraceMs } from "./storageKeys";

export function closeSockets(
  runtime: RoomRuntime,
  tokenHash?: string,
  reason = "Room membership ended",
): void {
  for (const socket of runtime.ctx.getWebSockets()) {
    if (tokenHash !== undefined) {
      const attachment: unknown = socket.deserializeAttachment();
      if (
        typeof attachment !== "object" ||
        attachment === null ||
        !("tokenHash" in attachment) ||
        attachment.tokenHash !== tokenHash
      )
        continue;
    }
    if (tokenHash === undefined) {
      try {
        const attachment = socket.deserializeAttachment() as { tokenHash?: string } | null;
        const notice = attachment?.tokenHash
          ? runtime.ctx.storage.kv.get<Record<string, TournamentReturn>>(tournamentReturnKey)?.[
              attachment.tokenHash
            ]
          : undefined;
        if (notice) socket.send(JSON.stringify(notice));
        else sendSocketError(runtime, socket, "not_found");
      } catch {
        // 通知に失敗しても接続を終了します。
      }
    }
    try {
      socket.close(1000, reason);
    } catch {
      // 切断済みの接続は、そのまま無視します。
    }
  }
}

export async function socketGone(runtime: RoomRuntime, socket: WebSocket): Promise<void> {
  const attachment: unknown = socket.deserializeAttachment();
  if (
    typeof attachment !== "object" ||
    attachment === null ||
    !("tokenHash" in attachment) ||
    typeof attachment.tokenHash !== "string"
  )
    return;
  const tokenHash = attachment.tokenHash;
  if (hasOpenConnection(runtime, tokenHash, socket)) return;
  await runtime.reconcileDeadlines();
  if (hasOpenConnection(runtime, tokenHash, socket)) return;
  const membership = readMembership(runtime, tokenHash);
  const room = readRoom(runtime);
  if (membership === null || room === null) return;
  const player = room.players.find((entry) => entry.id === membership.playerId);
  if (
    player !== undefined &&
    runtime.ctx.storage.kv.get(disconnectedAtKey(player.id)) === undefined
  ) {
    runtime.ctx.storage.kv.put(disconnectedAtKey(player.id), Date.now());
  }
  if (
    player === undefined ||
    !isHumanParticipant(runtime, player) ||
    player.reconnectDeadline !== null
  ) {
    broadcastRoom(runtime, room);
    return;
  }
  const updated = withIndexTransaction(runtime, () => {
    const current = readRoom(runtime);
    if (current === null) return null;
    runtime.ctx.storage.kv.put(disconnectedAtKey(player.id), Date.now());
    const next = roomSchema.parse({
      ...current,
      players: current.players.map((entry) =>
        entry.id === player.id
          ? { ...entry, reconnectDeadline: Date.now() + reconnectGraceMs }
          : entry,
      ),
    });
    runtime.ctx.storage.kv.put(roomStorageKey, next);
    return next;
  });
  if (updated !== null) broadcastRoom(runtime, updated);
}

export async function webSocketClose(
  runtime: RoomRuntime,
  socket: WebSocket,
  code: number,
  reason: string,
): Promise<void> {
  try {
    socket.close(code, reason);
  } catch {
    // 切断済みの接続は、そのまま無視します。
  }
  await socketGone(runtime, socket);
}

export async function webSocketError(runtime: RoomRuntime, socket: WebSocket): Promise<void> {
  try {
    socket.close(1011, "Connection error");
  } catch {
    // 切断済みの接続は、そのまま無視します。
  }
  await socketGone(runtime, socket);
}
