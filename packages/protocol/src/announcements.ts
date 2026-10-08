import { z } from "zod";
import { gameIdSchema } from "./gameSchemas";

export const announcementKindLabels = {
  improvement: "改善",
  feature: "新機能",
  tournament: "大会告知",
  other: "その他",
} as const;
export const announcementKindSchema = z.enum(["improvement", "feature", "tournament", "other"]);
export const announcementIdSchema = z.string().regex(/^[a-zA-Z0-9-]{1,80}$/);
export const announcementDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  });
const text = (max: number) =>
  z
    .string()
    .transform((value) => value.replace(/\r\n?/g, "\n").trim())
    .refine((value) => Array.from(value).length >= 1 && Array.from(value).length <= max);
export function announcementFirstLine(body: string): string {
  return body.replace(/\r\n?/g, "\n").trim().split("\n")[0]!;
}
export const announcementInputSchema = z
  .object({
    title: text(80),
    body: text(2000),
    date: announcementDateSchema,
    kind: announcementKindSchema,
    published: z.boolean(),
    lobbyGames: z.array(gameIdSchema).refine((games) => new Set(games).size === games.length),
  })
  .strict();
export const announcementPatchSchema = announcementInputSchema.extend({
  version: z.number().int().min(1),
});
export const announcementSummarySchema = z.object({
  id: announcementIdSchema,
  title: z.string(),
  summary: z.string(),
  date: announcementDateSchema,
  kind: announcementKindSchema,
});
export const announcementDetailSchema = announcementSummarySchema
  .omit({ summary: true })
  .extend({ body: z.string() });
export const announcementRecordSchema = announcementInputSchema.extend({
  id: announcementIdSchema,
  createdAtMs: z.number().int(),
  updatedAtMs: z.number().int(),
  version: z.number().int().min(1),
});
export const announcementListSchema = z.object({
  announcements: z.array(announcementSummarySchema),
  nextCursor: z.string().nullable(),
});
export const announcementAdminListSchema = z.object({
  announcements: z.array(announcementRecordSchema),
  nextCursor: z.string().nullable(),
});
export const lobbyAnnouncementSchema = z.object({
  announcement: announcementSummarySchema.nullable(),
});
export type AnnouncementInput = z.infer<typeof announcementInputSchema>;
export type AnnouncementRecord = z.infer<typeof announcementRecordSchema>;
export type AnnouncementSummary = z.infer<typeof announcementSummarySchema>;
export type AnnouncementDetail = z.infer<typeof announcementDetailSchema>;
