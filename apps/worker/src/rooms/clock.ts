import {
  roomTimeControl,
  type FinishedRoomClock,
  type PlayingRoomClock,
} from "@tetraboard/protocol";
import { colors, type Color } from "@tetraboard/four-reversi";

export function createClock(at: number): PlayingRoomClock {
  const remainingMainMs = Object.fromEntries(
    colors.map((color) => [color, roomTimeControl.mainTimeMs]),
  ) as Record<Color, number>;
  return {
    remainingMainMs,
    turnStartedAt: at,
    turnExpiresAt: at + roomTimeControl.mainTimeMs + roomTimeControl.byoyomiMs,
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
): PlayingRoomClock;
export function advanceClock(
  clock: PlayingRoomClock,
  previousTurn: Color,
  nextTurn: null,
  at: number,
  turnEnded: boolean,
): FinishedRoomClock;
export function advanceClock(
  clock: PlayingRoomClock,
  previousTurn: Color,
  nextTurn: Color | null,
  at: number,
  turnEnded: boolean,
): PlayingRoomClock | FinishedRoomClock;
export function advanceClock(
  clock: PlayingRoomClock,
  previousTurn: Color,
  nextTurn: Color | null,
  at: number,
  turnEnded: boolean,
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
    turnExpiresAt: at + remainingMainMs[nextTurn] + roomTimeControl.byoyomiMs,
  };
}
