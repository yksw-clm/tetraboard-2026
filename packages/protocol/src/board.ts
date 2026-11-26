import { z } from "zod";
import { boardPostIdSchema } from "./boardIds";
import { gameIdSchema } from "./gameSchemas";
import { getPublicMatchContract } from "./matches";
import { playerProfileReferenceSchema } from "./playerProfiles";
import { countCharacters } from "./rooms";

export { scanBoardLinks, type BoardLink, type BoardLinkOccurrence } from "./boardLinks";
export { boardPostIdSchema } from "./boardIds";

export const boardTextLimit = 1000;

export function boardTextLength(text: string): number {
  return countCharacters(text.trim());
}

export const boardTextSchema = z
  .string()
  .trim()
  .min(1)
  .refine((text) => boardTextLength(text) <= boardTextLimit);

export const boardAttachmentSchema = z.strictObject({
  matchId: getPublicMatchContract.params.shape.matchId,
  position: z.int().nonnegative(),
});

export const boardPostInputSchema = z.strictObject({
  requestId: z.uuid(),
  text: boardTextSchema,
  attachment: boardAttachmentSchema.optional(),
});

export const boardAuthorSchema = z.strictObject({
  name: z.string(),
  avatarUrl: z.string().nullable(),
  profileTarget: playerProfileReferenceSchema.nullable(),
});

const timestampSchema = z.int().nonnegative();
const countSchema = z.int().nonnegative();

export const boardReplySchema = z.strictObject({
  id: boardPostIdSchema,
  text: z.string(),
  attachment: boardAttachmentSchema.nullable(),
  author: boardAuthorSchema,
  postedAtMs: timestampSchema,
  likeCount: countSchema,
  liked: z.boolean(),
  own: z.boolean(),
});

export const boardPublishedPostSchema = boardReplySchema.extend({
  status: z.literal("published"),
  gameId: gameIdSchema,
  replyCount: countSchema,
});

export const boardDeletedPostSchema = z.strictObject({
  status: z.literal("deleted"),
  id: boardPostIdSchema,
  gameId: gameIdSchema,
  postedAtMs: timestampSchema,
  replyCount: countSchema,
});

export const boardPostSchema = z.discriminatedUnion("status", [
  boardPublishedPostSchema,
  boardDeletedPostSchema,
]);

export const boardPostingStateSchema = z.strictObject({
  acceptingPosts: z.boolean(),
  postingStopped: z.boolean(),
  availableAtMs: timestampSchema,
  serverTimeMs: timestampSchema,
});

export const boardCursorSchema = z
  .string()
  .regex(/^\d{1,16}:[0-9a-f-]{36}$/)
  .refine((value) => {
    const [time, id] = value.split(":");
    return Number.isSafeInteger(Number(time)) && boardPostIdSchema.safeParse(id).success;
  });

export const boardTimelineSchema = boardPostingStateSchema.extend({
  posts: z.array(boardPostSchema).max(20),
  nextCursor: boardCursorSchema.nullable(),
});

export const boardRepliesSchema = z.strictObject({
  replies: z.array(boardReplySchema).max(50),
  nextCursor: boardCursorSchema.nullable(),
});

export const boardDetailSchema = boardRepliesSchema.extend({
  ...boardPostingStateSchema.shape,
  post: boardPostSchema,
});

export const boardPostResultSchema = z.strictObject({
  post: boardPublishedPostSchema.nullable(),
  availableAtMs: timestampSchema,
});

export const boardReplyResultSchema = z.strictObject({
  reply: boardReplySchema.nullable(),
  availableAtMs: timestampSchema,
});

export const boardLikeResultSchema = z.strictObject({
  liked: z.boolean(),
  likeCount: countSchema,
});

export const boardReportReasonLabels = {
  harassment: "晒し・嫌がらせ",
  abuse: "暴言",
  spam: "スパム・宣伝",
  personalInfo: "個人情報",
  other: "その他",
} as const;

export type BoardReportReason = keyof typeof boardReportReasonLabels;
export const boardReportReasons = Object.keys(boardReportReasonLabels) as BoardReportReason[];
export const boardReportInputSchema = z.strictObject({ reason: z.enum(boardReportReasons) });

const boardReportIdSchema = z.uuid();
const boardAccountIdSchema = z.string().min(1);

const boardAdminReportSchema = z.strictObject({
  id: boardReportIdSchema,
  postId: boardPostIdSchema,
  parentId: boardPostIdSchema.nullable(),
  gameId: gameIdSchema,
  reason: boardReportInputSchema.shape.reason,
  authorName: z.string(),
  text: z.string(),
  postedAtMs: timestampSchema,
  reportedAtMs: timestampSchema,
  status: z.enum(["open", "resolved"]),
  reportCount: countSchema,
  postDeleted: z.boolean(),
  moderatorDeletedAtMs: timestampSchema.nullable(),
  authorStopped: z.boolean(),
  authorWithdrawn: z.boolean(),
});

export const boardAdminSchema = z.strictObject({
  acceptingPosts: z.boolean(),
  reports: z.array(boardAdminReportSchema).max(500),
  stoppedSenders: z.array(z.strictObject({ accountId: boardAccountIdSchema, name: z.string() })),
});

export const boardModerationSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("delete"), postId: boardPostIdSchema }),
  z.strictObject({ action: z.literal("stop"), postId: boardPostIdSchema, stopped: z.boolean() }),
  z.strictObject({ action: z.literal("unstop"), accountId: boardAccountIdSchema }),
  z.strictObject({ action: z.literal("accepting"), accepting: z.boolean() }),
  z.strictObject({ action: z.literal("resolve"), reportId: boardReportIdSchema }),
]);

export type BoardAdminReport = z.infer<typeof boardAdminReportSchema>;
export type BoardModeration = z.infer<typeof boardModerationSchema>;
export type BoardAuthor = z.infer<typeof boardAuthorSchema>;
export type BoardAttachment = z.infer<typeof boardAttachmentSchema>;
export type BoardPostInput = z.infer<typeof boardPostInputSchema>;
export type BoardPost = z.infer<typeof boardPostSchema>;
export type BoardPublishedPost = z.infer<typeof boardPublishedPostSchema>;
export type BoardReply = z.infer<typeof boardReplySchema>;
