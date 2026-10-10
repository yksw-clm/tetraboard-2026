import { createContext, useContext } from "react";
import type { RoomStampNotification } from "@tetraboard/protocol";

export const RoomStampContext = createContext<Readonly<Record<string, RoomStampNotification>>>({});
export function usePlayerStamp(playerId?: string) {
  const stamps = useContext(RoomStampContext);
  return playerId ? stamps[playerId] : undefined;
}
