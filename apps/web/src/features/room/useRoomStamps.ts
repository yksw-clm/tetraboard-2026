import { useCallback, useEffect, useRef, useState } from "react";
import { roomStampDurationMs, type RoomStampNotification } from "@tetraboard/protocol";
import type { SharedRoomSession } from "./useRoomTransport";

export function useRoomStamps(
  session: Pick<
    SharedRoomSession,
    "room" | "connection" | "leaving" | "unavailable" | "subscribeStamps"
  >,
  hiddenSenders: readonly string[],
) {
  const [stamps, setStamps] = useState<Record<string, RoomStampNotification>>({});
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const clear = useCallback(() => {
    for (const timer of timers.current.values()) clearTimeout(timer);
    timers.current.clear();
    setStamps({});
  }, []);
  const { room, connection, leaving, unavailable, subscribeStamps } = session;
  useEffect(() => {
    if (connection !== "接続済み" || leaving || unavailable) {
      // eslint-disable-next-line react/set-state-in-effect -- 接続と退室の外部状態に同期して演出・タイマーを破棄します。
      clear();
      return;
    }
    const playerIds = new Set(room.players.map((player) => player.id));
    const hidden = new Set(hiddenSenders);
    for (const [id, timer] of timers.current) {
      if (playerIds.has(id) && !hidden.has(id)) continue;
      clearTimeout(timer);
      timers.current.delete(id);
      setStamps((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    }
    return subscribeStamps((notification) => {
      if (notification === null) {
        clear();
        return;
      }
      if (
        document.visibilityState !== "visible" ||
        notification.instanceId !== room.instanceId ||
        !playerIds.has(notification.senderId) ||
        hidden.has(notification.senderId)
      )
        return;
      const id = notification.senderId;
      clearTimeout(timers.current.get(id));
      setStamps((current) => ({ ...current, [id]: notification }));
      timers.current.set(
        id,
        setTimeout(() => {
          timers.current.delete(id);
          setStamps((current) => {
            const next = { ...current };
            delete next[id];
            return next;
          });
        }, roomStampDurationMs),
      );
    });
  }, [
    room.instanceId,
    room.players,
    connection,
    leaving,
    unavailable,
    hiddenSenders,
    subscribeStamps,
    clear,
  ]);
  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState !== "visible") clear();
    };
    document.addEventListener("visibilitychange", hidden);
    const currentTimers = timers.current;
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      for (const timer of currentTimers.values()) clearTimeout(timer);
      currentTimers.clear();
    };
  }, [clear]);
  return stamps;
}
