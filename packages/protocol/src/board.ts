import { z } from "zod";
import { gameIdSchema } from "./gameSchemas";
import { playerProfileReferenceSchema } from "./playerProfiles";
import { countCharacters } from "./rooms";

export { scanBoardLinks, type BoardLink, type BoardLinkOccurrence } from "./boardLinks";

export const boardTextSchema = z
  .string()
  .trim()
  .min(1)
  .refine((text) => countCharacters(text) <= 1000);

export const boardPostInputSchema = z.strictObject({ requestId: z.uuid(), text: boardTextSchema });

export const boardAuthorSchema = z.strictObject({
  name: z.string(),
  avatarUrl: z.string().nullable(),
  profileTarget: playerProfileReferenceSchema.nullable(),
});

const timestampSchema = z.int().nonnegative();
const countSchema = z.int().nonnegative();

export const boardReplySchema = z.strictObject({
  id: z.uuid(),
  text: z.string(),
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
  id: z.uuid(),
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
    return Number.isSafeInteger(Number(time)) && z.uuid().safeParse(id).success;
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

export type BoardAuthor = z.infer<typeof boardAuthorSchema>;
export type BoardPost = z.infer<typeof boardPostSchema>;
export type BoardPublishedPost = z.infer<typeof boardPublishedPostSchema>;
export type BoardReply = z.infer<typeof boardReplySchema>;
