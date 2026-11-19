import type { RoomRuntime } from "../../durableObjects/gameRoom/runtime";
import {
  chatKey,
  disconnectedAtKey,
  lastChatAtKey,
  mutedKey,
  viewerSecretKey,
} from "../../durableObjects/gameRoom/storageKeys";
import { fourGomokuCpuJobKey } from "../../rooms/fourGomokuProgress";
import { fourReversiAiJobKey, fourReversiCpuJobKey } from "../../rooms/fourReversiProgress";
import { fourShogiAiJobKey, shogiEliminatedHandsKey } from "../../rooms/fourShogiProgress";
import { gomokuCpuJobKey } from "../../rooms/gomokuProgress";
import { matchStartKey } from "../../rooms/matchStore";
import { replayKey, roomStorageKey, shogiCpuJobKey } from "../../rooms/progressHelpers";
import { currentRoomStateVersion, roomStateVersionKey } from "./roomStateVersion";
import { shogiMatchStartKey, standardShogiMatchStartKey } from "../../rooms/shogiMatchStore";
import { tournamentCredentialVersionKey } from "@tetraboard/context-tournament";
import { departedKey } from "./state";
export function clearRoom(runtime: RoomRuntime): void {
  runtime.ctx.storage.kv.delete(roomStorageKey);
  runtime.ctx.storage.kv.delete(roomStateVersionKey);
  runtime.ctx.storage.kv.delete(replayKey);
  runtime.ctx.storage.kv.delete(matchStartKey);
  runtime.ctx.storage.kv.delete(shogiMatchStartKey);
  runtime.ctx.storage.kv.delete(shogiEliminatedHandsKey);
  runtime.ctx.storage.kv.delete(standardShogiMatchStartKey);
  runtime.ctx.storage.kv.delete(chatKey);
  runtime.ctx.storage.kv.delete(mutedKey);
  runtime.ctx.storage.kv.delete(viewerSecretKey);
  runtime.ctx.storage.kv.delete(shogiCpuJobKey);
  runtime.ctx.storage.kv.delete("standard-shogi-cpu-job");
  runtime.ctx.storage.kv.delete(gomokuCpuJobKey);
  runtime.ctx.storage.kv.delete(fourGomokuCpuJobKey);
  runtime.ctx.storage.kv.delete(fourReversiCpuJobKey);
  runtime.ctx.storage.kv.delete(fourReversiAiJobKey);
  runtime.ctx.storage.kv.delete(fourShogiAiJobKey);
}
export function initializeRoom(runtime: RoomRuntime, secret: string): void {
  runtime.ctx.storage.kv.put(roomStateVersionKey, currentRoomStateVersion);
  runtime.ctx.storage.kv.put(viewerSecretKey, secret);
}
export function clearPlayerTransientState(runtime: RoomRuntime, id: string): void {
  runtime.ctx.storage.kv.delete(disconnectedAtKey(id));
  runtime.ctx.storage.kv.delete(lastChatAtKey(id));
}
export function clearClosedPlayerState(runtime: RoomRuntime, id: string): void {
  runtime.ctx.storage.kv.delete(tournamentCredentialVersionKey(id));
  clearPlayerTransientState(runtime, id);
  runtime.ctx.storage.kv.delete(departedKey(id));
}
