import { runRoomUseCase, type RoomOperation, type RoomStatePort } from "@tetraboard/context-room";
import type { RoomRuntime } from "../../durableObjects/gameRoom/runtime";
import type { LifecycleIdentity } from "./lifecycleState";
import { readRoom } from "./state";
import { withIndexTransaction } from "./transaction";
import { roomPorts } from "./useCases";

// この入口は、ルームの変更を state の保存口で確定する use-case に使います。
export function invokeRoomTransaction<T>(
  runtime: RoomRuntime,
  action: (operation: RoomOperation) => T,
  identity?: LifecycleIdentity,
): T {
  const initial = readRoom(runtime);
  const ports = roomPorts(runtime, identity);
  let current = initial;
  let firstRead = true;
  const state: RoomStatePort = {
    ...ports.state,
    hasRoom: () => current !== null,
    readRoom: () => {
      if (!firstRead) return ports.state.readRoom();
      firstRead = false;
      return initial;
    },
    saveRoom: (room) => {
      current = ports.state.saveRoom(room);
      return current;
    },
    clearRoom: () => {
      ports.state.clearRoom();
      current = null;
    },
  };
  return withIndexTransaction(
    runtime,
    () => {
      const outcome = runRoomUseCase({ ...ports, state }, Date.now(), action);
      runtime.effects.publish(outcome.effects);
      return outcome.value;
    },
    initial,
    () => current,
  );
}
