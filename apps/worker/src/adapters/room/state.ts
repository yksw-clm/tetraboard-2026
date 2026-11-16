import {
  roomMembershipSchema,
  roomSchema,
  type Room,
  type RoomMembership,
} from "@tetraboard/protocol";
import type { RoomRuntime } from "../../durableObjects/gameRoom/runtime";
import { membershipStorageKey, playerTokenKey } from "../../durableObjects/gameRoom/storageKeys";
import { storedAccount } from "../../flows/accountSeats/seats";
import { replayKey, roomStorageKey } from "../../rooms/progressHelpers";
import {
  currentRoomStateVersion,
  migrateRoomStateV0ToV1,
  roomStateVersionKey,
} from "../../rooms/roomStateVersion";
export const departedKey = (playerId: string) => `departed:${playerId}`;
export function readRoom(runtime: RoomRuntime): Room | null {
  const saved = runtime.ctx.storage.kv.get<Room>(roomStorageKey);
  if (saved === undefined) return null;
  const version = runtime.ctx.storage.kv.get<number>(roomStateVersionKey) ?? 0;
  if (version >= currentRoomStateVersion) return roomSchema.parse(saved);
  return runtime.ctx.storage.transactionSync(() => {
    const parsed = migrateRoomStateV0ToV1(saved, {
      readReplay: () => runtime.ctx.storage.kv.get(replayKey),
      migrateLegacy: (room, original, readReplay) =>
        runtime.gameAdapter(room).migrateLegacy(room, original, readReplay),
    });
    if (!parsed.success) throw parsed.error;
    runtime.ctx.storage.kv.put(roomStorageKey, parsed.data);
    runtime.ctx.storage.kv.put(roomStateVersionKey, currentRoomStateVersion);
    return parsed.data;
  });
}

export function readMembership(runtime: RoomRuntime, tokenHash: string): RoomMembership | null {
  const value = runtime.ctx.storage.kv.get(membershipStorageKey(tokenHash));
  return value === undefined ? null : roomMembershipSchema.parse(value);
}

export function publicMembership(runtime: RoomRuntime, membership: RoomMembership): RoomMembership {
  return storedAccount(runtime, membership.playerId)?.accountId
    ? { ...membership, accountLinked: true }
    : membership;
}

export function playerTokenHash(runtime: RoomRuntime, playerId: string): string | null {
  return runtime.ctx.storage.kv.get<string>(playerTokenKey(playerId)) ?? null;
}

// 復帰期限切れの退室は期限イベントで確定し、復帰待ちと脱落後の在室を含めます。
export function isHumanParticipant(runtime: RoomRuntime, player: Room["players"][number]): boolean {
  if (
    player.kind !== "human" ||
    player.retired ||
    runtime.ctx.storage.kv.get(departedKey(player.id))
  )
    return false;
  if (storedAccount(runtime, player.id)?.occupying === false) return false;
  const hash = playerTokenHash(runtime, player.id);
  return hash !== null && readMembership(runtime, hash)?.playerId === player.id;
}

/** 期限を確認した入口から、awaitを挟まず現在の資格を照合します。 */
export function currentRoomMembership(
  runtime: RoomRuntime,
  tokenHash: string,
):
  | { status: "found"; membership: RoomMembership }
  | { status: "not_found" }
  | { status: "unauthorized" } {
  const room = readRoom(runtime);
  if (room === null) {
    return { status: "not_found" };
  }

  const membership = readMembership(runtime, tokenHash);
  if (membership === null) {
    return { status: "unauthorized" };
  }

  return room.players.some((player) => player.kind === "human" && player.id === membership.playerId)
    ? { status: "found", membership: publicMembership(runtime, membership) }
    : { status: "unauthorized" };
}

// フェーズ 6 の掃除で消す。旧計測の保存待ちだけを初回起動時に削除します。
export function purgeLegacyAnalytics(runtime: RoomRuntime) {
  if (runtime.ctx.storage.kv.get("legacy-analytics-purged")) return;
  runtime.ctx.storage.transactionSync(() => {
    for (const [key] of runtime.ctx.storage.kv.list({ prefix: "analytics-pending:" }))
      runtime.ctx.storage.kv.delete(key);
    runtime.ctx.storage.kv.delete("analytics-player-aliases");
    runtime.ctx.storage.kv.put("legacy-analytics-purged", true);
  });
}
