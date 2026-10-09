import { initializeClock, advanceTurnClock } from "./clockCore";
import { roomTimeControl, type RoomTimeControl, type ReversiClock } from "@tetraboard/protocol";
import { type Color } from "@tetraboard/reversi";

type FinishedReversiClock = {
  remainingMainMs: Record<Color, number>;
  turnStartedAt: null;
  turnExpiresAt: null;
};
export function createClock(
  at: number,
  timeControl: RoomTimeControl = roomTimeControl,
): ReversiClock {
  const remainingMainMs: Record<Color, number> = {
    black: timeControl.mainTimeMs,
    white: timeControl.mainTimeMs,
  };
  return initializeClock(remainingMainMs, at, timeControl);
}

export function isClockExpired(clock: Pick<ReversiClock, "turnExpiresAt">, at: number): boolean {
  return at >= clock.turnExpiresAt;
}

export function advanceClock(
  clock: ReversiClock,
  previousTurn: Color,
  nextTurn: Color,
  at: number,
  turnEnded: boolean,
  timeControl?: RoomTimeControl,
): ReversiClock;
export function advanceClock(
  clock: ReversiClock,
  previousTurn: Color,
  nextTurn: null,
  at: number,
  turnEnded: boolean,
  timeControl?: RoomTimeControl,
): FinishedReversiClock;
export function advanceClock(
  clock: ReversiClock,
  previousTurn: Color,
  nextTurn: Color | null,
  at: number,
  turnEnded: boolean,
  timeControl?: RoomTimeControl,
): ReversiClock | FinishedReversiClock;
export function advanceClock(
  clock: ReversiClock,
  previousTurn: Color,
  nextTurn: Color | null,
  at: number,
  turnEnded: boolean,
  timeControl: RoomTimeControl = roomTimeControl,
): ReversiClock | FinishedReversiClock {
  return advanceTurnClock(clock, previousTurn, nextTurn, at, turnEnded, timeControl);
}
