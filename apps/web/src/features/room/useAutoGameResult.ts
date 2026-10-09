import { useEffect, useRef, useState } from "react";
import { isFourShogiRoom, isShogiRoom, type Room } from "@tetraboard/protocol";

function resultKey(room: Room): string | null {
  if (room.status !== "waiting" || !room.lastRound) return null;
  const round =
    isFourShogiRoom(room) || isShogiRoom(room) ? room.lastRound.roundId : room.lastRound.replay?.id;
  return `${room.instanceId}:${round ?? JSON.stringify(room.lastRound.game)}`;
}

export function useAutoGameResult(room: Room, blocked: boolean, unavailable: boolean) {
  const [observation, setObservation] = useState<{
    room: Room;
    pending: { key: string } | null;
    visible: string | null;
  }>({ room, pending: null, visible: null });
  const currentKey = resultKey(room);
  if (
    observation.room !== room ||
    (unavailable && (observation.pending !== null || observation.visible !== null))
  ) {
    const ended =
      observation.room.instanceId === room.instanceId &&
      observation.room.status === "playing" &&
      room.status === "waiting" &&
      currentKey !== null;
    setObservation({
      room,
      pending: unavailable
        ? null
        : ended
          ? { key: currentKey }
          : observation.pending?.key === currentKey
            ? observation.pending
            : null,
      visible: !unavailable && observation.visible === currentKey ? observation.visible : null,
    });
  }
  const blockedRef = useRef(blocked);
  useEffect(() => {
    blockedRef.current = blocked;
  }, [blocked]);
  const pending = observation.pending;
  useEffect(() => {
    if (!pending || unavailable) return;
    const timer = setTimeout(() => {
      setObservation((previous) =>
        previous.pending === pending
          ? { ...previous, pending: null, visible: blockedRef.current ? null : pending.key }
          : previous,
      );
    }, 1000);
    return () => clearTimeout(timer);
  }, [pending, unavailable]);

  function dismiss() {
    setObservation((previous) => ({ ...previous, pending: null, visible: null }));
  }
  return {
    visible: observation.visible !== null && observation.visible === currentKey && !unavailable,
    dismiss,
  };
}
