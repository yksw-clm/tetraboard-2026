import type { FourShogiRoom } from "@tetraboard/protocol";
import { fetchFourShogiReplay } from "./fourShogiReplay";
import { useEventRoomReplay } from "./useEventRoomReplay";
export function useFourShogiRoomReplay(room: FourShogiRoom) {
  return useEventRoomReplay(room, fetchFourShogiReplay);
}
