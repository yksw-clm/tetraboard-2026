import { z } from "zod";
import { countCharacters } from "./rooms";

export const usernameSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/^@/, "").toLowerCase())
  .pipe(z.string().regex(/^[a-z0-9_]{3,20}$/));
export const profileInputSchema = z.object({
  name: z
    .string()
    .trim()
    .refine((value) => countCharacters(value) >= 1 && countCharacters(value) <= 10),
  username: usernameSchema,
});
export const accountProfileSchema = z.object({
  profileId: z.uuid().nullable().optional(),
  name: z.string(),
  username: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  profileCompleted: z.boolean(),
  isGuest: z.boolean().optional(),
  nameCustomized: z.boolean().optional(),
});
export const accountSessionSchema = z.object({ user: accountProfileSchema.nullable() });
export type AccountProfile = z.infer<typeof accountProfileSchema>;
