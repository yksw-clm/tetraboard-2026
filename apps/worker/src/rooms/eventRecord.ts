import { z } from "zod";

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
