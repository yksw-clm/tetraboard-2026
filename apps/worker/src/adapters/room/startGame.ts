import { prepareStart, startGame as start } from "@tetraboard/context-room";
import type { RoomRuntime } from "../../durableObjects/gameRoom/runtime";
import { cpuCapacityKey } from "../../durableObjects/gameRoom/storageKeys";
import { reserveCpuCapacity } from "./cpuCapacity";
import { withIndexTransaction } from "./transaction";
import { invokeRoomUseCase } from "./useCases";

export function startGame(runtime: RoomRuntime, hash: string) {
  return runtime.ctx.blockConcurrencyWhile(async () => {
    const prepared = invokeRoomUseCase(runtime, (op) => prepareStart(op, hash));
    if (prepared.status !== "ready") return prepared;
    const capacity = await reserveCpuCapacity(runtime, prepared.room);
    if (typeof capacity === "string") return { status: capacity };
    return withIndexTransaction(runtime, () => {
      if (capacity) runtime.ctx.storage.kv.put(cpuCapacityKey, capacity);
      return invokeRoomUseCase(runtime, (op) => start(op, prepared.room));
    });
  });
}
