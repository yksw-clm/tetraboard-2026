import { hasProfileRating } from "@tetraboard/context-rating";
import { roomIdleMs } from "@tetraboard/context-room";
import type { ProfileRatings } from "@tetraboard/protocol";
import { roomSchema } from "@tetraboard/protocol";
import { profileRatingsKey } from "../../adapters/rating/profileRatings";
import { isHumanParticipant, migrateStoredRoom, playerTokenHash } from "../../adapters/room/state";
import { storedAccount } from "../../flows/accountSeats/seats";
import { registrationForPlayer } from "../../flows/guestRegistration/records";
import type { MatchmakingRoomReservation } from "@tetraboard/context-matchmaking";
import { roomStorageKey } from "../../adapters/room/games/progressHelpers";
import { currentRoomStateVersion, roomStateVersionKey } from "../../adapters/room/roomStateVersion";
import type { RoomRuntime } from "./runtime";
import { hasOpenConnection } from "./socket/membership";
import { disconnectedAtKey, reconnectGraceMs } from "./storageKeys";
import { getRoom } from "./queries";

export async function getShareMetadata(runtime: RoomRuntime, instanceId: string) {
  // ルームの進行や期限処理を呼ばず、クローラーの取得で対局・時計・保存を変更しません。
  const saved = runtime.ctx.storage.kv.get(roomStorageKey);
  const version = runtime.ctx.storage.kv.get<number>(roomStateVersionKey) ?? 0;
  const parsed =
    version >= currentRoomStateVersion
      ? roomSchema.safeParse(saved)
      : migrateStoredRoom(runtime, saved, version);
  if (!parsed.success) return null;
  const room = parsed.data;
  const now = Date.now();
  if (room.instanceId !== instanceId || room.lastActivityAtMs + roomIdleMs <= now) return null;
  const retained = room.players.some((player) => {
    if (!isHumanParticipant(runtime, player)) return false;
    if ((registrationForPlayer(runtime, player.id)?.holdUntilMs ?? 0) > now) return true;
    const hash = playerTokenHash(runtime, player.id);
    if (hash && hasOpenConnection(runtime, hash)) return true;
    const disconnectedAt = runtime.ctx.storage.kv.get<number>(disconnectedAtKey(player.id));
    const deadline =
      player.reconnectDeadline ??
      (disconnectedAt === undefined ? now + reconnectGraceMs : disconnectedAt + reconnectGraceMs);
    return deadline > now;
  });
  return retained
    ? { id: room.id, instanceId: room.instanceId, settings: { game: room.settings.game } }
    : null;
}

export async function resolvePlayerProfile(
  runtime: RoomRuntime,
  instanceId: string,
  playerId: string,
) {
  const room = await getRoom(runtime);
  if (!room) return { status: "not_found" as const };
  if (room.instanceId !== instanceId) return { status: "room_changed" as const };
  const player = room.players.find((p) => p.id === playerId);
  if (player?.kind === "human" && player.retired) return { status: "not_found" as const };
  if (!player) return { status: "not_found" as const };
  const matchmaking = "matchmaking" in room ? room.matchmaking : undefined;
  const rated =
    matchmaking &&
    runtime.ctx.storage.kv.get<MatchmakingRoomReservation>(`matchmaking:${matchmaking.id}`)?.rating;
  return {
    status: "found" as const,
    game: room.settings.game,
    player,
    accountId: storedAccount(runtime, playerId)?.accountId ?? null,
    ...(matchmaking && rated && hasProfileRating(room.settings.game)
      ? {
          profileRating:
            runtime.ctx.storage.kv.get<ProfileRatings>(profileRatingsKey(matchmaking.id))?.[
              playerId
            ] ??
            (player.kind === "human"
              ? { timing: "before" as const, status: "unavailable" as const }
              : undefined),
        }
      : {}),
  };
}
