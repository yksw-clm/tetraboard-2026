type SnapshotPosition =
  | { kind: "initial" }
  | { kind: "final" }
  | { kind: "step"; stepIndex: number }
  | { kind: "pass"; stepIndex: number; passIndex: number };

type SnapshotReplay = { steps: readonly { action: unknown; passedColors?: readonly unknown[] }[] };

export function snapshotReplayPositions(
  replay: SnapshotReplay | null | undefined,
): SnapshotPosition[] {
  if (!replay) return [{ kind: "final" }];
  const positions: SnapshotPosition[] = [{ kind: "initial" }];
  replay.steps.forEach(({ passedColors }, stepIndex) => {
    positions.push({ kind: "step", stepIndex });
    passedColors?.forEach((_, passIndex) => positions.push({ kind: "pass", stepIndex, passIndex }));
  });
  return positions;
}

type EventPosition = { kind: "initial" } | { kind: "event"; eventIndex: number };

export function eventReplayPositions(eventCount: number): EventPosition[] {
  const positions: EventPosition[] = [{ kind: "initial" }];
  for (let eventIndex = 0; eventIndex < eventCount; eventIndex++) {
    positions.push({ kind: "event", eventIndex });
  }
  return positions;
}
