import { storedAccount } from "../accountSeats/seats";
import type { RoomRuntime } from "../../durableObjects/gameRoom/runtime";
import { advanceMatchmakingStart } from "./start";
import { roomSchema, matchmakingRules, type Room } from "@tetraboard/protocol";
import {
  membershipStorageKey,
  playerTokenKey,
  disconnectedAtKey,
  reconnectGraceMs,
} from "../../durableObjects/gameRoom/storageKeys";
import { roomStorageKey } from "../../rooms/progressHelpers";

export async function rekeyMatchmakingPlayer(
  runtime: RoomRuntime,
  matchId: string,
  instanceId: string,
  playerId: string,
  version: number,
  tokenHash: string,
) {
  await runtime.reconcileDeadlines();
  const room = runtime.readRoom();
  if (
    !room ||
    !("matchmaking" in room) ||
    room.matchmaking?.id !== matchId ||
    room.instanceId !== instanceId ||
    !storedAccount(runtime, playerId)?.occupying
  )
    return false;
  const current = runtime.ctx.storage.kv.get<number>(`matchmaking-version:${playerId}`) ?? 0;
  if (version < current) return false;
  const old = runtime.playerTokenHash(playerId);
  if (version === current) {
    if (old !== tokenHash) return false;
    await advanceMatchmakingStart(runtime);
    runtime.markAlarm();
    return true;
  }
  replaceMatchmakingCredential(runtime, room, playerId, version, tokenHash, old);
  for (const socket of runtime.ctx.getWebSockets())
    if (old && (socket.deserializeAttachment() as { tokenHash?: string } | null)?.tokenHash === old)
      socket.close(1000, "操作元が変わりました");
  await advanceMatchmakingStart(runtime);
  runtime.markAlarm();
  return true;
}

function replaceMatchmakingCredential(
  runtime: RoomRuntime,
  room: Room,
  playerId: string,
  version: number,
  tokenHash: string,
  old: string | null,
) {
  runtime.ctx.storage.transactionSync(() => {
    const membership = old ? runtime.readMembership(old) : null;
    if (old) runtime.ctx.storage.kv.delete(membershipStorageKey(old));
    runtime.ctx.storage.kv.put(playerTokenKey(playerId), tokenHash);
    runtime.ctx.storage.kv.put(membershipStorageKey(tokenHash), {
      playerId,
      role: membership?.role ?? "player",
    });
    runtime.ctx.storage.kv.put(`matchmaking-version:${playerId}`, version);
    runtime.ctx.storage.kv.put(disconnectedAtKey(playerId), Date.now());
    const updated = roomSchema.parse({
      ...room,
      players: room.players.map((p) =>
        p.id === playerId
          ? {
              ...p,
              reconnectDeadline:
                p.reconnectDeadline ??
                (room.status === "waiting" && !room.lastRound
                  ? room.matchmaking!.preparedAtMs + matchmakingRules.connectionGraceMs
                  : Date.now() + reconnectGraceMs),
            }
          : p,
      ),
    });
    runtime.ctx.storage.kv.put(roomStorageKey, updated);
  });
}
