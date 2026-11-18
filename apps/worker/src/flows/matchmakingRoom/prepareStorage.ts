import type { ProfileRatings, Room } from "@tetraboard/protocol";
import { profileRatingsKey } from "../../adapters/rating/profileRatings";
import { withIndexTransaction } from "../../adapters/room/transaction";
import { appendSystem } from "../../durableObjects/gameRoom/chat";
import type { RoomCpuCapacity, RoomRuntime } from "../../durableObjects/gameRoom/runtime";
import {
  accountKey,
  cpuCapacityKey,
  disconnectedAtKey,
  membershipStorageKey,
  playerTokenKey,
  viewerSecretKey,
} from "../../durableObjects/gameRoom/storageKeys";
import { bytesToHex } from "../../durableObjects/gameRoom/tokenCrypto";
import type {
  MatchmakingRoomInput,
  MatchmakingRoomReservation,
} from "@tetraboard/context-matchmaking";
import { playerLabel, roomStorageKey } from "../../rooms/progressHelpers";
import { currentRoomStateVersion, roomStateVersionKey } from "../../rooms/roomStateVersion";
import { analyticsPlayerKey } from "../../usageEvents/matches";

export function persistMatchmakingRoom(
  runtime: RoomRuntime,
  input: MatchmakingRoomInput,
  room: Room,
  cpuCount: number,
  profileRatings: ProfileRatings,
  capacity: RoomCpuCapacity | null,
) {
  const rating = input.rating;
  withIndexTransaction(runtime, () => {
    if (capacity) runtime.ctx.storage.kv.put(cpuCapacityKey, capacity);
    runtime.ctx.storage.kv.put(roomStorageKey, room);
    runtime.ctx.storage.kv.put(roomStateVersionKey, currentRoomStateVersion);
    if (rating) runtime.ctx.storage.kv.put(profileRatingsKey(input.matchId), profileRatings);
    runtime.ctx.storage.kv.put(`matchmaking:${input.matchId}`, {
      ...input,
      phase: "waiting",
      ...(runtime.aiService().AI_WARMUP_ENABLED === "true" && cpuCount > 0 && rating
        ? { aiWarmup: { state: "pending", attempts: 0, nextAtMs: Date.now() } }
        : {}),
    } satisfies MatchmakingRoomReservation);
    for (const [index, { admission: a, tokenHash, version, search }] of input.players.entries()) {
      runtime.ctx.storage.kv.put(accountKey(a.playerId), { ...a, occupying: true });
      runtime.ctx.storage.kv.put(membershipStorageKey(tokenHash), {
        playerId: a.playerId,
        role: index === 0 ? "host" : "player",
      });
      runtime.ctx.storage.kv.put(playerTokenKey(a.playerId), tokenHash);
      runtime.ctx.storage.kv.put(`matchmaking-version:${a.playerId}`, version);
      runtime.ctx.storage.kv.put(disconnectedAtKey(a.playerId), Date.now());
      runtime.ctx.storage.kv.put(analyticsPlayerKey(a.playerId), {
        accountId: a.accountId,
        visitorId: null,
        isGuest: Boolean(a.isGuest),
        isTest: search?.isTest ?? false,
      });
    }
    for (const p of room.players)
      appendSystem(runtime, "joined", `${playerLabel(p)}が入室しました`);
    runtime.ctx.storage.kv.put(
      viewerSecretKey,
      bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
    );
  });
}
