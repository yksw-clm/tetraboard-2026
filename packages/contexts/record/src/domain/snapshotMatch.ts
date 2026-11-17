import type { EventReplay, StoredRecord } from "./eventRecord";

export type SnapshotMatch = {
  id: string;
  settings: { game: string };
  game: unknown;
  replay: {
    id: string;
    initial: unknown;
    steps: { action: object; game: object; passedColors?: unknown }[];
  };
};
export function encodeSnapshotMatch<R extends SnapshotMatch>(
  record: R,
): { record: StoredRecord<R>; events: object[] } {
  const { steps, ...initial } = record.replay as R["replay"];
  const replay: EventReplay<R["replay"]> = {
    ...initial,
    format: "events",
    version: 1,
    eventCount: steps.length,
  };
  if (record.settings.game === "four-gomoku") {
    const omitted = steps.flatMap((step, index) => ("lastMoves" in step.game ? [] : [index]));
    if (omitted.length) replay.omittedLastMoves = omitted;
  }
  const events: object[] = steps.map((step) => ({
    ...step.action,
    ...("passedColors" in step ? { passedColors: step.passedColors } : {}),
  }));
  return { record: { ...record, replay }, events };
}
export function rebuildSnapshotMatch<R extends SnapshotMatch, E>(
  record: StoredRecord<R>,
  events: unknown[],
  replay: (initial: R["replay"]["initial"], events: E[]) => unknown[],
  parse: (event: unknown) => E,
) {
  const {
    format: _format,
    version: _version,
    eventCount,
    omittedLastMoves,
    ...initial
  } = record.replay;
  if (events.length !== eventCount) throw new Error("Match event count mismatch");
  const states = replay(initial.initial, events.map(parse));
  const omitted = new Set(omittedLastMoves);
  if ([...omitted].some((index) => index >= eventCount))
    throw new Error("Invalid state field index");
  const steps = states.map((state, index) => {
    const event = events[index];
    if (!event || typeof event !== "object") throw new Error("Invalid match event");
    const { passedColors, ...action } = event as { passedColors?: string[] };
    if (omitted.has(index) && state && typeof state === "object") {
      const { lastMoves: _lastMoves, ...rest } = state as { lastMoves?: unknown };
      state = rest;
    }
    return { action, game: state, ...(passedColors === undefined ? {} : { passedColors }) };
  });
  return { ...record, replay: { ...initial, steps } };
}

export function verifyFinalState(record: {
  game: unknown;
  replay: { initial: unknown; steps: { game: unknown }[] };
}) {
  if (
    JSON.stringify(record.replay.steps.at(-1)?.game ?? record.replay.initial) !==
    JSON.stringify(record.game)
  )
    throw new Error("Match replay final state mismatch");
}

export function verifySnapshotReplay(restored: unknown, original: unknown) {
  if (JSON.stringify(restored) !== JSON.stringify(original))
    throw new Error("Match event replay does not match saved steps");
}
