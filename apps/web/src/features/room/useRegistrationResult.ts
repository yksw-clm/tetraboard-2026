import { useEffect, useState } from "react";
import { isFourShogiRoom, type Room } from "@tetraboard/protocol";

const shownKey = "tetraboard:registration-result-shown";
let shownInMemory = false;
function alreadyShown() {
  if (shownInMemory) return true;
  try {
    return sessionStorage.getItem(shownKey) === "1";
  } catch {
    return false;
  }
}
function resultKey(room: Room): string | null {
  if (room.status !== "waiting" || !room.lastRound) return null;
  const round = isFourShogiRoom(room) ? room.lastRound?.roundId : room.lastRound.replay?.id;
  return `${room.instanceId}:${round ?? JSON.stringify(room.lastRound.game)}`;
}

export function useRegistrationResult(
  room: Room,
  playerId: string | undefined,
  eligible: boolean,
  blocked: boolean,
  unavailable: boolean,
) {
  const [observation, setObservation] = useState<{ room: Room; pending: string | null }>({
    room,
    pending: null,
  });
  const currentKey = resultKey(room);
  if (observation.room !== room) {
    const ended =
      observation.room.instanceId === room.instanceId &&
      observation.room.status === "playing" &&
      room.status === "waiting" &&
      room.lastRound?.players.some((p) => p.id === playerId);
    setObservation({
      room,
      pending:
        ended && eligible && !alreadyShown()
          ? currentKey
          : observation.pending === currentKey
            ? observation.pending
            : null,
    });
  }
  const visible =
    observation.pending !== null &&
    observation.pending === currentKey &&
    eligible &&
    !blocked &&
    !unavailable;
  useEffect(() => {
    if (!visible) return;
    shownInMemory = true;
    try {
      sessionStorage.setItem(shownKey, "1");
    } catch {
      /* 保存不能でも同じページ内では繰り返さない。 */
    }
  }, [visible]);
  function dismiss() {
    setObservation((previous) => ({ ...previous, pending: null }));
  }
  return { visible, dismiss };
}
