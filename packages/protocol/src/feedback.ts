import { gameScopeSchema } from "./gameSchemas";
import { z } from "zod";
import { countCharacters } from "./rooms";

export const feedbackKindSchema = z.enum(["bug", "request", "opinion"]);
export const feedbackGameSchema = gameScopeSchema;
export const feedbackStatusSchema = z.enum([
  "new",
  "reviewing",
  "planned",
  "working",
  "done",
  "declined",
  "spam",
]);
export const feedbackPrioritySchema = z.enum(["high", "normal", "low"]);
const feedbackRatingSchema = z.number().int().min(1).max(5);
const feedbackOpponentSchema = z.enum(["cpu", "human"]);
const text = (max: number, required = false) =>
  z
    .string()
    .trim()
    .refine((value) => countCharacters(value) <= max && (!required || countCharacters(value) >= 1));
export const feedbackTechnicalSchema = z
  .object({
    page: z.enum(["lobby", "room", "replay", "error", "feedback", "other"]),
    game: feedbackGameSchema,
    browser: z.string().max(512),
    width: z.number().int().min(1).max(20000),
    height: z.number().int().min(1).max(20000),
    build: z.string().max(80),
    room: z
      .object({
        id: z.string().regex(/^\d{5}$/),
        instanceId: z.uuid(),
        roundId: z.uuid().nullable(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const feedbackInputSchema = z
  .object({
    submissionId: z.uuid(),
    accountRequired: z.boolean().default(false),
    kind: feedbackKindSchema,
    game: feedbackGameSchema,
    body: text(2000),
    rating: feedbackRatingSchema.optional(),
    opponent: feedbackOpponentSchema.optional(),
    expectation: text(500).default(""),
    steps: text(1000).default(""),
    technical: feedbackTechnicalSchema.nullable().default(null),
  })
  .strict()
  .refine((input) => input.kind === "bug" || (!input.steps && input.technical === null))
  .refine((input) =>
    input.rating === undefined
      ? input.opponent === undefined && input.body.length > 0
      : input.opponent !== undefined &&
        input.kind === "opinion" &&
        input.game !== "all" &&
        !input.expectation,
  );
export const feedbackReceiptSchema = z.object({ id: z.uuid() });
export const feedbackTopicSchema = z.object({
  id: z.uuid(),
  name: text(80, true),
  version: z.number().int().min(1),
});
export const feedbackTopicInputSchema = z.object({ name: text(80, true) }).strict();
export const feedbackTopicPatchSchema = feedbackTopicInputSchema.extend({
  version: z.number().int().min(1),
});
export const feedbackTopicsSchema = z.object({ topics: z.array(feedbackTopicSchema) });
export const feedbackDeleteSchema = z.object({ version: z.number().int().min(1) }).strict();
export const feedbackRecordSchema = z.object({
  id: z.uuid(),
  kind: feedbackKindSchema,
  game: feedbackGameSchema,
  body: z.string(),
  rating: feedbackRatingSchema.nullable().default(null),
  opponent: feedbackOpponentSchema.nullable().default(null),
  expectation: z.string(),
  steps: z.string(),
  technical: feedbackTechnicalSchema.nullable(),
  author: z.enum(["account", "guest"]),
  internal: z.boolean(),
  receivedAtMs: z.number(),
  expiresAtMs: z.number(),
  firstReviewedAtMs: z.number().nullable(),
  status: feedbackStatusSchema,
  priority: feedbackPrioritySchema,
  topicId: z.uuid().nullable(),
  note: z.string(),
  issueUrl: z.string(),
  hasAttachment: z.boolean(),
  version: z.number().int().min(1),
});
export const feedbackListSchema = z.object({
  feedback: z.array(feedbackRecordSchema),
  nextCursor: z.string().nullable(),
});
export const feedbackDetailSchema = z.object({
  feedback: feedbackRecordSchema,
  history: z.array(
    z.object({ atMs: z.number(), admin: z.string(), changes: z.record(z.string(), z.unknown()) }),
  ),
});
export const feedbackQuerySchema = z.object({
  author: z.enum(["account", "guest"]).optional(),
  opponent: feedbackOpponentSchema.optional(),
  rating: z.coerce.number().int().min(1).max(5).optional(),
  kind: feedbackKindSchema.optional(),
  game: feedbackGameSchema.optional(),
  status: feedbackStatusSchema.optional(),
  priority: feedbackPrioritySchema.optional(),
  topicId: z.union([z.uuid(), z.literal("none")]).optional(),
  cursor: z.string().max(512).optional(),
});
const issueUrl = z.union([
  z.literal(""),
  z.url().refine((value) => /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+$/.test(value)),
]);
export const feedbackPatchSchema = z
  .object({
    version: z.number().int().min(1),
    status: feedbackStatusSchema,
    priority: feedbackPrioritySchema,
    topicId: z.uuid().nullable(),
    note: text(4000),
    issueUrl,
    published: z.boolean().default(false),
  })
  .strict()
  .refine(
    (v) => (v.status !== "done" || v.published) && (v.status !== "declined" || v.note.length > 0),
  );
export const feedbackSummarySchema = z.object({
  asOfMs: z.number(),
  unreviewed: z.number(),
  oldestUnreviewedMs: z.number().nullable(),
  medianReviewMs: z.number().nullable(),
  topics: z.array(
    z.object({
      id: z.uuid().nullable(),
      name: z.string(),
      posts: z.number(),
      reporters: z.number(),
    }),
  ),
});
export type FeedbackInput = z.infer<typeof feedbackInputSchema>;
export type FeedbackTechnical = z.infer<typeof feedbackTechnicalSchema>;
export type FeedbackRecord = z.infer<typeof feedbackRecordSchema>;
export type FeedbackDetail = z.infer<typeof feedbackDetailSchema>;
export type FeedbackTopic = z.infer<typeof feedbackTopicSchema>;
export type FeedbackPatch = z.infer<typeof feedbackPatchSchema>;
export type FeedbackQuery = z.infer<typeof feedbackQuerySchema>;
export type FeedbackSummary = z.infer<typeof feedbackSummarySchema>;
