import { type Room } from "@tetraboard/protocol";
import type { RoomCpuCapacity, RoomRuntime } from "../../durableObjects/gameRoom/runtime";
import { cpuCapacityKey } from "../../durableObjects/gameRoom/storageKeys";
import { isClockExpired } from "../../rooms/clock";
import { cpuMoveDelayMs } from "../../rooms/progressHelpers";
import { readRoom } from "./state";
const cpuCapacitySequenceKey = "external-cpu-capacity-sequence";
export async function reserveCpuCapacity(
  runtime: RoomRuntime,
  room: Room,
): Promise<RoomCpuCapacity | null | "cpu_capacity_full" | "internal_error"> {
  const game = runtime.gameAdapter(room).cpu.capacity.game(room);
  if (!game) return null;
  const seats = runtime.gameAdapter(room).cpu.capacity.seats(room);
  if (!seats) return null;
  await runtime.jobs.cpuCapacityJob.flush();
  if (runtime.ctx.storage.kv.get(cpuCapacityKey) !== undefined) return "internal_error";
  const sequence = (runtime.ctx.storage.kv.get<number>(cpuCapacitySequenceKey) ?? 0) + 1;
  const reservation: RoomCpuCapacity = {
    game,
    roomId: room.id,
    sequence,
    instanceId: room.instanceId,
    releaseAtMs: Date.now() + 30_000,
  };
  // RPC中の枠を解放せず、入力ゲートの期限内に確定しなければAlarmで回収します。
  runtime.ctx.storage.transactionSync(() => {
    runtime.ctx.storage.kv.put(cpuCapacityKey, reservation);
    runtime.ctx.storage.kv.put(cpuCapacitySequenceKey, sequence);
  });
  try {
    runtime.alarms.mark();
    await runtime.alarms.sync();
    if (await runtime.cpuCapacity.getByName(game).reserve(room.id, sequence, seats))
      return { ...reservation, releaseAtMs: null };
    runtime.ctx.storage.kv.delete(cpuCapacityKey);
    runtime.alarms.mark();
    return "cpu_capacity_full";
  } catch {
    runtime.ctx.storage.kv.put(cpuCapacityKey, { ...reservation, releaseAtMs: Date.now() });
    runtime.alarms.mark();
    runtime.ctx.waitUntil(runtime.jobs.cpuCapacityJob.flush());
    return "internal_error";
  }
}

export function hasCpuCapacity(runtime: RoomRuntime, room: Room): boolean {
  const reservation = runtime.ctx.storage.kv.get<RoomCpuCapacity>(cpuCapacityKey);
  return reservation?.instanceId === room.instanceId && reservation.releaseAtMs === null;
}

export async function recoverPlayingCpuCapacity(runtime: RoomRuntime): Promise<void> {
  const room = readRoom(runtime);
  if (
    room?.status !== "playing" ||
    hasCpuCapacity(runtime, room) ||
    !runtime.gameAdapter(room).cpu.capacity.game(room) ||
    !runtime.gameAdapter(room).cpu.currentCpu(room) ||
    !runtime.gameAdapter(room).cpu.capacity.recoverPlaying(room) ||
    room.clock.turnStartedAt + cpuMoveDelayMs > Date.now() ||
    isClockExpired(room.clock, Date.now())
  )
    return;
  // 既存局・配備前に割当済みの局は、次の外部AI要求前に枠を確保します。
  await runtime.ctx.blockConcurrencyWhile(async () => {
    const playing = readRoom(runtime);
    if (playing?.status !== "playing" || hasCpuCapacity(runtime, playing)) return;
    const reservation = await reserveCpuCapacity(runtime, playing);
    if (reservation && typeof reservation !== "string")
      runtime.ctx.storage.kv.put(cpuCapacityKey, reservation);
  });
}
