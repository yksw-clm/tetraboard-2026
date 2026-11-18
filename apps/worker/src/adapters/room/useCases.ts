import {
  closeRoom as close,
  recordDeparture as depart,
  appendSystem,
  runRoomUseCase,
  type RoomAdmission,
  type RoomOperation,
  type RoomPorts,
} from "@tetraboard/context-room";
import type { Room } from "@tetraboard/protocol";
import { gameCapacity } from "@tetraboard/protocol/games";
import { profileAvatarUrl } from "../../accounts/auth";
import type { AccountAdmission } from "../../flows/accountSeats/types";
import type { RoomRuntime } from "../../durableObjects/gameRoom/runtime";
import { prepareRoomSettings } from "../../rooms/applyRoomSettings";
import { lifecycleState, type LifecycleIdentity } from "./lifecycleState";

export function roomPorts(runtime: RoomRuntime, identity?: LifecycleIdentity): RoomPorts {
  return {
    state: lifecycleState(runtime, identity),
    game: (room) => {
      const adapter = runtime.gameAdapter(room);
      return {
        ...adapter,
        start: (waiting) => adapter.start(waiting, { kind: "normal" }),
        capacity: gameCapacity(room.settings.game),
        keepsPlayingWithoutHumans: (current) => adapter.cpu.keepsPlayingWithoutHumans(current),
        prepareSettings: prepareRoomSettings,
      };
    },
  };
}

export function invokeRoomUseCase<T>(
  runtime: RoomRuntime,
  action: (operation: RoomOperation) => T,
  identity?: LifecycleIdentity,
  now = Date.now(),
): T {
  const outcome = runRoomUseCase(roomPorts(runtime, identity), now, action);
  runtime.effects.publish(outcome.effects);
  return outcome.value;
}

export function closeRoom(runtime: RoomRuntime): void {
  invokeRoomUseCase(runtime, close);
}
export function recordDeparture(runtime: RoomRuntime, player: Room["players"][number]): void {
  invokeRoomUseCase(runtime, (op) => depart(op, player));
}
export function roomAdmission(admission?: AccountAdmission): RoomAdmission | undefined {
  return (
    admission && {
      instanceId: admission.instanceId,
      playerId: admission.playerId,
      name: admission.name,
      avatarUrl: profileAvatarUrl(admission.avatarKey, admission.avatarPresetId),
      ...(admission.isGuest ? { isGuest: true } : {}),
    }
  );
}

export function appendRoomSystem(
  runtime: RoomRuntime,
  event: import("@tetraboard/protocol").SystemChatMessage["event"],
  text: string,
): void {
  invokeRoomUseCase(runtime, (op) => appendSystem(op, event, text));
}
