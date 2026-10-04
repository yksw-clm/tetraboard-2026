import { initializeClock, advanceTurnClock } from "./clockCore";
import {
  roomTimeControl,
  type RoomTimeControl,
  type PlayingShogiClock,
} from "@tetraboard/protocol";
import { type Side } from "@tetraboard/four-shogi";

export function createShogiClock(
  at: number,
  timeControl: RoomTimeControl = roomTimeControl,
): PlayingShogiClock {
  const remainingMainMs: Record<Side, number> = {
    south: timeControl.mainTimeMs,
    west: timeControl.mainTimeMs,
    north: timeControl.mainTimeMs,
    east: timeControl.mainTimeMs,
  };
  return initializeClock(remainingMainMs, at, timeControl);
}
export function advanceShogiClock(
  clock: PlayingShogiClock,
  previous: Side,
  next: Side,
  at: number,
  turnEnded: boolean,
  timeControl: RoomTimeControl = roomTimeControl,
): PlayingShogiClock {
  return advanceTurnClock(clock, previous, next, at, turnEnded, timeControl);
}
