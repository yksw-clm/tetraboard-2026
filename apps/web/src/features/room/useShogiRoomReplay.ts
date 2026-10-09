import type { ShogiRoom } from "@tetraboard/protocol";
import { fetchShogiReplay } from "./standardShogiReplay";
import { useEventRoomReplay } from "./useEventRoomReplay";
export function useShogiRoomReplay(room: ShogiRoom) {
  return useEventRoomReplay(room, fetchShogiReplay);
}
