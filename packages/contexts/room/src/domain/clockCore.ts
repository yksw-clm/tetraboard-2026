import type { RoomTimeControl } from "@tetraboard/protocol";

export type PlayingClock<Seat extends string> = {
  remainingMainMs: Record<Seat, number>;
  turnStartedAt: number;
  turnExpiresAt: number;
};
export type FinishedClock<Seat extends string> = {
  remainingMainMs: Record<Seat, number>;
  turnStartedAt: null;
  turnExpiresAt: null;
};

export function initializeClock<Seat extends string>(
  remainingMainMs: Record<Seat, number>,
  at: number,
  timeControl: RoomTimeControl,
): PlayingClock<Seat> {
  return {
    remainingMainMs,
    turnStartedAt: at,
    turnExpiresAt: at + timeControl.mainTimeMs + timeControl.byoyomiMs,
  };
}

export function advanceTurnClock<Seat extends string>(
  clock: PlayingClock<Seat>,
  previous: Seat,
  next: Seat,
  at: number,
  turnEnded: boolean,
  timeControl: RoomTimeControl,
): PlayingClock<Seat>;
export function advanceTurnClock<Seat extends string>(
  clock: PlayingClock<Seat>,
  previous: Seat,
  next: null,
  at: number,
  turnEnded: boolean,
  timeControl: RoomTimeControl,
): FinishedClock<Seat>;
export function advanceTurnClock<Seat extends string>(
  clock: PlayingClock<Seat>,
  previous: Seat,
  next: Seat | null,
  at: number,
  turnEnded: boolean,
  timeControl: RoomTimeControl,
): PlayingClock<Seat> | FinishedClock<Seat>;
export function advanceTurnClock<Seat extends string>(
  clock: PlayingClock<Seat>,
  previous: Seat,
  next: Seat | null,
  at: number,
  turnEnded: boolean,
  timeControl: RoomTimeControl,
): PlayingClock<Seat> | FinishedClock<Seat> {
  if (!turnEnded && next === previous) return clock;
  const elapsed = Math.max(0, at - clock.turnStartedAt);
  const remainingMainMs = {
    ...clock.remainingMainMs,
    [previous]: Math.max(0, clock.remainingMainMs[previous] - elapsed),
  };
  if (next === null) return { remainingMainMs, turnStartedAt: null, turnExpiresAt: null };
  return {
    remainingMainMs,
    turnStartedAt: at,
    turnExpiresAt: at + remainingMainMs[next] + timeControl.byoyomiMs,
  };
}
