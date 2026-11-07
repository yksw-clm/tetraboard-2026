import { z } from "zod";
import { countCharacters } from "./rooms";
import { gameIdSchema } from "./gameSchemas";
import { gameIds } from "./games";

export const profileMessageSchema = z
  .string()
  .refine((value) => !/[\r\n\u2028\u2029]/u.test(value), "改行は使えません。")
  .transform((value) => value.trim())
  .refine((value) => countCharacters(value) <= 30, "ひとことは30文字以内で入力してください。");
export const favoriteGamesSchema = z
  .array(gameIdSchema)
  .max(3)
  .refine((games) => new Set(games).size === games.length)
  .transform((games) => gameIds.filter((game) => games.includes(game)));
export const profileDetailsSchema = z.object({
  profileMessage: profileMessageSchema,
  favoriteGames: favoriteGamesSchema,
});
