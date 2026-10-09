import { z } from "zod";

export const shogiSideSchema = z.enum(["south", "north"]);
const position = z.strictObject({ x: z.int().min(0).max(8), y: z.int().min(0).max(8) });
const handKind = z.enum(["rook", "bishop", "gold", "silver", "knight", "lance", "pawn"]);
const sideRecord = <T extends z.ZodType>(schema: T) =>
  z.strictObject({ south: schema, north: schema });
const piece = z.strictObject({
  id: z.int().nonnegative(),
  side: shogiSideSchema,
  kind: z.enum(["king", "rook", "bishop", "gold", "silver", "knight", "lance", "pawn"]),
  promoted: z.boolean(),
});
export const shogiActionSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("movePiece"),
    from: position,
    to: position,
    promote: z.boolean(),
  }),
  z.strictObject({ type: z.literal("dropPiece"), pieceKind: handKind, to: position }),
]);
export const shogiEliminationSchema = z.strictObject({
  side: shogiSideSchema,
  reason: z.enum([
    "resigned",
    "left",
    "timeout",
    "disconnected",
    "checkmate",
    "no_legal_actions",
    "perpetual_check",
    "impasse",
    "invalid_declaration",
  ]),
  rank: z.literal(2),
  group: z.literal(0),
});
const result = z.strictObject({
  winner: shogiSideSchema.nullable(),
  reason: z.enum([
    "resigned",
    "left",
    "timeout",
    "disconnected",
    "checkmate",
    "no_legal_actions",
    "perpetual_check",
    "impasse",
    "invalid_declaration",
    "repetition",
    "declaration",
    "move_limit",
  ]),
});
const base = z.strictObject({
  rulesVersion: z.literal(1),
  players: sideRecord(z.string()),
  board: z.array(z.array(piece.nullable()).length(9)).length(9),
  hands: sideRecord(
    z.strictObject({
      rook: z.int().nonnegative(),
      bishop: z.int().nonnegative(),
      knight: z.int().nonnegative(),
      lance: z.int().nonnegative(),
      gold: z.int().nonnegative(),
      silver: z.int().nonnegative(),
      pawn: z.int().nonnegative(),
    }),
  ),
  eliminations: z.array(shogiEliminationSchema).max(2),
  drawProposals: z
    .array(shogiSideSchema)
    .max(2)
    .refine((entries) => new Set(entries).size === entries.length)
    .default([]),
  nonChecks: sideRecord(z.int().nonnegative()),
  nextPieceId: z.int().nonnegative(),
  moveNumber: z.int().nonnegative(),
  lastMove: z
    .strictObject({
      side: shogiSideSchema,
      action: shogiActionSchema,
      piece,
      captured: piece.nullable(),
    })
    .nullable(),
});
export const playingShogiStateSchema = base.extend({
  status: z.literal("playing"),
  turn: shogiSideSchema,
  result: z.null(),
});
export const finishedShogiStateSchema = base.extend({
  status: z.literal("finished"),
  turn: z.null(),
  result,
});
/** Public state deliberately excludes the server's repetition index. */
export const shogiPublicStateSchema = z.discriminatedUnion("status", [
  playingShogiStateSchema,
  finishedShogiStateSchema,
]);
export const shogiReplayInitialSchema = z.strictObject({
  players: sideRecord(z.string()),
});
export const shogiReplayEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("declaration"), side: shogiSideSchema }),
  z.strictObject({
    type: z.literal("drawProposal"),
    side: shogiSideSchema,
    proposed: z.boolean(),
  }),
  z.strictObject({
    type: z.literal("action"),
    side: shogiSideSchema,
    action: shogiActionSchema,
  }),
  z.strictObject({
    type: z.literal("eliminate"),
    side: shogiSideSchema,
    reason: z.enum(["resigned", "left", "timeout", "disconnected"]),
  }),
]);
export const shogiReplayPageSchema = z.strictObject({
  instanceId: z.uuid(),
  roundId: z.uuid(),
  rulesVersion: z.literal(1),
  initial: shogiReplayInitialSchema,
  eventCount: z.int().nonnegative(),
  events: z
    .array(z.strictObject({ index: z.int().nonnegative(), event: shogiReplayEventSchema }))
    .max(100),
  nextCursor: z.int().nonnegative().nullable(),
});
export type ShogiPublicState = z.infer<typeof shogiPublicStateSchema>;
export type ShogiReplayPage = z.infer<typeof shogiReplayPageSchema>;
export type ShogiReplayEvent = z.infer<typeof shogiReplayEventSchema>;
export type ShogiAction = z.infer<typeof shogiActionSchema>;
