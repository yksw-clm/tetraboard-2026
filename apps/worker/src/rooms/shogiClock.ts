import {
  roomTimeControl,
  type RoomTimeControl,
  type PlayingShogiClock,
} from "@tetraboard/protocol";
import { sides, type Side } from "@tetraboard/four-shogi";

export function createShogiClock(
  at: number,
  timeControl: RoomTimeControl = roomTimeControl,
): PlayingShogiClock {
  return {
    remainingMainMs: Object.fromEntries(
      sides.map((side) => [side, timeControl.mainTimeMs]),
    ) as Record<Side, number>,
    turnStartedAt: at,
    turnExpiresAt: at + timeControl.mainTimeMs + timeControl.byoyomiMs,
  };
}
export function advanceShogiClock(
  clock: PlayingShogiClock,
  previous: Side,
  next: Side,
  at: number,
  turnEnded: boolean,
  timeControl: RoomTimeControl = roomTimeControl,
): PlayingShogiClock {
  if (!turnEnded && previous === next) return clock;
  const remainingMainMs = {
    ...clock.remainingMainMs,
    [previous]: Math.max(
      0,
      clock.remainingMainMs[previous] - Math.max(0, at - clock.turnStartedAt),
    ),
  };
  return {
    remainingMainMs,
    turnStartedAt: at,
    turnExpiresAt: at + remainingMainMs[next] + timeControl.byoyomiMs,
  };
}
