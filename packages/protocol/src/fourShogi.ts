import { z } from "zod";

export const fourShogiSideSchema = z.enum(["south", "west", "north", "east"]);
const position = z.strictObject({ x: z.int().min(0).max(8), y: z.int().min(0).max(8) });
const handKind = z.enum(["rook", "gold", "silver", "pawn"]);
const sideRecord = <T extends z.ZodType>(schema: T) =>
  z.strictObject({ south: schema, west: schema, north: schema, east: schema });
export const fourShogiFormationAnalysisSchema = z.strictObject({
  analyzerId: z.string().min(1).max(64),
  analysisVersion: z.int().positive(),
  rulesVersion: z.int().positive(),
  roundId: z.uuid(),
  positionRevision: z.int().nonnegative(),
  matches: sideRecord(
    z
      .array(
        z.strictObject({
          id: z.string().min(1).max(64),
          name: z.string().min(1).max(40),
          matchedSquares: z.array(position).length(9),
        }),
      )
      .max(6),
  ),
});
export type FourShogiFormationAnalysis = z.infer<typeof fourShogiFormationAnalysisSchema>;
const piece = z.strictObject({
  id: z.int().nonnegative(),
  side: fourShogiSideSchema,
  kind: z.enum(["king", "rook", "gold", "silver", "pawn"]),
  promoted: z.boolean(),
});
export const fourShogiActionSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("movePiece"),
    from: position,
    to: position,
    promote: z.boolean(),
  }),
  z.strictObject({ type: z.literal("dropPiece"), pieceKind: handKind, to: position }),
]);
export const fourShogiEliminationSchema = z.strictObject({
  side: fourShogiSideSchema,
  reason: z.enum(["resigned", "left", "timeout", "disconnected", "checkmate", "no_legal_actions"]),
  rank: z.int().min(1).max(4).nullable(),
  group: z.int().nonnegative(),
});
const result = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("singles"),
    reason: z.enum(["last_player", "no_survivors", "repetition", "agreement"]),
    standings: z.array(z.strictObject({ side: fourShogiSideSchema, rank: z.int().min(1).max(4) })),
  }),
  z.strictObject({
    mode: z.literal("doubles"),
    reason: z.enum(["team_eliminated", "simultaneous_mate", "repetition", "agreement"]),
    winner: z.enum(["south-north", "west-east"]).nullable(),
  }),
]);
const base = z.strictObject({
  rulesVersion: z.literal(1),
  mode: z.enum(["singles", "doubles"]),
  players: sideRecord(z.string()),
  threePlayerAttackProhibited: z.boolean(),
  board: z.array(z.array(piece.nullable()).length(9)).length(9),
  hands: sideRecord(
    z.strictObject({
      rook: z.int().nonnegative(),
      gold: z.int().nonnegative(),
      silver: z.int().nonnegative(),
      pawn: z.int().nonnegative(),
    }),
  ),
  eliminations: z.array(fourShogiEliminationSchema).max(4),
  drawProposals: z
    .array(fourShogiSideSchema)
    .max(4)
    .refine((entries) => new Set(entries).size === entries.length)
    .default([]),
  attackRelations: z.array(
    z.strictObject({
      attacker: fourShogiSideSchema,
      target: fourShogiSideSchema,
      reasons: z.array(z.enum(["check", "capture", "threat", "blockade"])),
      targetPieceIds: z.array(z.int().nonnegative()),
      pendingSides: z.array(fourShogiSideSchema),
    }),
  ),
  recaptureSquares: sideRecord(z.array(position)),
  nextPieceId: z.int().nonnegative(),
  moveNumber: z.int().nonnegative(),
  lastMove: z
    .strictObject({
      side: fourShogiSideSchema,
      action: fourShogiActionSchema,
      piece,
      captured: piece.nullable(),
    })
    .nullable(),
});
export const playingFourShogiStateSchema = base.extend({
  status: z.literal("playing"),
  turn: fourShogiSideSchema,
  result: z.null(),
});
export const finishedFourShogiStateSchema = base.extend({
  status: z.literal("finished"),
  turn: z.null(),
  result,
});
/** Public state deliberately excludes the server's repetition index. */
export const fourShogiPublicStateSchema = z.discriminatedUnion("status", [
  playingFourShogiStateSchema,
  finishedFourShogiStateSchema,
]);
export const fourShogiReplayInitialSchema = z.strictObject({
  mode: z.enum(["singles", "doubles"]),
  players: sideRecord(z.string()),
  threePlayerAttackProhibited: z.boolean(),
});
export const fourShogiReplayEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("drawProposal"),
    side: fourShogiSideSchema,
    proposed: z.boolean(),
  }),
  z.strictObject({
    type: z.literal("action"),
    side: fourShogiSideSchema,
    action: fourShogiActionSchema,
  }),
  z.strictObject({
    type: z.literal("eliminate"),
    side: fourShogiSideSchema,
    reason: z.enum(["resigned", "left", "timeout", "disconnected"]),
  }),
]);
export const fourShogiReplayPageSchema = z.strictObject({
  instanceId: z.uuid(),
  roundId: z.uuid(),
  rulesVersion: z.literal(1),
  initial: fourShogiReplayInitialSchema,
  eventCount: z.int().nonnegative(),
  events: z
    .array(z.strictObject({ index: z.int().nonnegative(), event: fourShogiReplayEventSchema }))
    .max(100),
  nextCursor: z.int().nonnegative().nullable(),
});
export type FourShogiPublicState = z.infer<typeof fourShogiPublicStateSchema>;
export type FourShogiReplayPage = z.infer<typeof fourShogiReplayPageSchema>;
export type FourShogiReplayEvent = z.infer<typeof fourShogiReplayEventSchema>;
export type FourShogiAction = z.infer<typeof fourShogiActionSchema>;
