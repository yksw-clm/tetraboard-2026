import { initializeClock, advanceTurnClock } from "./clockCore";
import {
  roomTimeControl,
  type RoomTimeControl,
  type FinishedRoomClock,
  type PlayingRoomClock,
} from "@tetraboard/protocol";
import { type Color } from "@tetraboard/four-reversi";

export function createClock(
  at: number,
  timeControl: RoomTimeControl = roomTimeControl,
): PlayingRoomClock {
  const remainingMainMs: Record<Color, number> = {
    black: timeControl.mainTimeMs,
    white: timeControl.mainTimeMs,
    red: timeControl.mainTimeMs,
    blue: timeControl.mainTimeMs,
  };
  return initializeClock(remainingMainMs, at, timeControl);
}

export function isClockExpired(
  clock: Pick<PlayingRoomClock, "turnExpiresAt">,
  at: number,
): boolean {
  return at >= clock.turnExpiresAt;
}

export function advanceClock(
  clock: PlayingRoomClock,
  previousTurn: Color,
  nextTurn: Color,
  at: number,
  turnEnded: boolean,
  timeControl?: RoomTimeControl,
): PlayingRoomClock;
export function advanceClock(
  clock: PlayingRoomClock,
  previousTurn: Color,
  nextTurn: null,
  at: number,
  turnEnded: boolean,
  timeControl?: RoomTimeControl,
): FinishedRoomClock;
export function advanceClock(
  clock: PlayingRoomClock,
  previousTurn: Color,
  nextTurn: Color | null,
  at: number,
  turnEnded: boolean,
  timeControl?: RoomTimeControl,
): PlayingRoomClock | FinishedRoomClock;
export function advanceClock(
  clock: PlayingRoomClock,
  previousTurn: Color,
  nextTurn: Color | null,
  at: number,
  turnEnded: boolean,
  timeControl: RoomTimeControl = roomTimeControl,
): PlayingRoomClock | FinishedRoomClock {
  return advanceTurnClock(clock, previousTurn, nextTurn, at, turnEnded, timeControl);
}
