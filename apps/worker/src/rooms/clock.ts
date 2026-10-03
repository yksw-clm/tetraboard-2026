import {
  roomTimeControl,
  type RoomTimeControl,
  type FinishedRoomClock,
  type PlayingRoomClock,
} from "@tetraboard/protocol";
import { colors, type Color } from "@tetraboard/four-reversi";

export function createClock(
  at: number,
  timeControl: RoomTimeControl = roomTimeControl,
): PlayingRoomClock {
  const remainingMainMs = Object.fromEntries(
    colors.map((color) => [color, timeControl.mainTimeMs]),
  ) as Record<Color, number>;
  return {
    remainingMainMs,
    turnStartedAt: at,
    turnExpiresAt: at + timeControl.mainTimeMs + timeControl.byoyomiMs,
  };
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
  if (!turnEnded && nextTurn === previousTurn) return clock;

  const elapsed = Math.max(0, at - clock.turnStartedAt);
  const remainingMainMs = {
    ...clock.remainingMainMs,
    [previousTurn]: Math.max(0, clock.remainingMainMs[previousTurn] - elapsed),
  };
  if (nextTurn === null) {
    return { remainingMainMs, turnStartedAt: null, turnExpiresAt: null };
  }
  return {
    remainingMainMs,
    turnStartedAt: at,
    turnExpiresAt: at + remainingMainMs[nextTurn] + timeControl.byoyomiMs,
  };
}
