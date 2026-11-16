export type SnapshotReplay = { id: string; initial: unknown; steps: unknown[] };
export type EventReplay<R extends SnapshotReplay> = Omit<R, "steps"> & {
  format: "events";
  version: 1;
  eventCount: number;
  omittedLastMoves?: number[];
};
export type StoredRecord<T extends { replay: SnapshotReplay }> = Omit<T, "replay"> & {
  replay: EventReplay<T["replay"]>;
};
