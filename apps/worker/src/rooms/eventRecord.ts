import { z } from "zod";
export type { SnapshotReplay, EventReplay, StoredRecord } from "@tetraboard/context-record";

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
