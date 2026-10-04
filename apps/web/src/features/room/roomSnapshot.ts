import type { Room } from "@tetraboard/protocol";
/** スキーマ解析済みのスナップショットを、接続中のゲームの具体型へ限定する。 */
export function roomSnapshotFor<T extends Room>(
  room: Room,
  guard: (room: Room) => room is T,
): T | null {
  return guard(room) ? room : null;
}
