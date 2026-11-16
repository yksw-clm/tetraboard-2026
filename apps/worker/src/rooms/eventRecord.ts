import { z } from "zod";

export type SnapshotReplay = { id: string; initial: unknown; steps: unknown[] };
export type EventReplay<R extends SnapshotReplay> = Omit<R, "steps"> & {
  format: "events";
  version: 1;
  eventCount: number;
  omittedLastMoves?: number[];
};
export type StoredRecord<T extends { replay: SnapshotReplay }> = Omit<T, "replay"> & {
  replay: T["replay"] | EventReplay<T["replay"]>;
};
export function isEventReplay(replay: unknown): replay is EventReplay<SnapshotReplay> {
  return typeof replay === "object" && replay !== null && "format" in replay;
}
export function snapshotRecord<T extends { replay: SnapshotReplay }>(record: StoredRecord<T>): T {
  if (isEventReplay(record.replay)) throw new Error("Match events have not been replayed");
  return record as T;
}
export function eventReplaySchema<I>(schema: {
  shape: { id: z.ZodType<string>; initial: z.ZodType<I> };
}) {
  return z.strictObject({
    id: schema.shape.id,
    initial: schema.shape.initial,
    format: z.literal("events"),
    version: z.literal(1),
    eventCount: z.int().nonnegative(),
    omittedLastMoves: z.array(z.int().nonnegative()).optional(),
  });
}
