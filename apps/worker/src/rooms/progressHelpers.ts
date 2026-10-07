import type { Room, PlayerAppearance } from "@tetraboard/protocol";
export const roomStorageKey = "room";
export const replayKey = "round-replay";
export const shogiCpuJobKey = "shogi-cpu-job";
export const cpuMoveDelayMs = 500;
export function nextPublicUpdateAt(room: Room): number {
  return Math.max(Date.now(), room.publicUpdatedAtMs + 1);
}
export function playerLabel(player: Room["players"][number]): string {
  return player.kind === "cpu" ? `CPU Lv${player.level}` : player.name;
}
export function playerAppearance(player: Room["players"][number]): PlayerAppearance {
  return player.kind === "cpu"
    ? { kind: "cpu", level: player.level }
    : { kind: "human", avatarUrl: player.avatarUrl };
}
function randomIndex(length: number): number {
  const range = 2 ** 32;
  const limit = Math.floor(range / length) * length;
  const value = new Uint32Array(1);
  do {
    crypto.getRandomValues(value);
  } while (value[0] >= limit);
  return value[0] % length;
}

export function shuffledAssignments<T>(values: readonly T[]): T[] {
  const result: T[] = [...values];
  for (let index = result.length - 1; index > 0; index--) {
    const other = randomIndex(index + 1);
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}
