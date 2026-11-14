import { z } from "zod";
import { roomTimeControlSchema } from "@tetraboard/protocol";

export const gameSchema = z.enum(["four-reversi", "four-shogi"]);
export const profileNameSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/);
export function origin(value: string): string {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))
  )
    throw Error("接続先はHTTPSのorigin、またはHTTPのlocalhost/127.0.0.1を指定してください");
  return url.origin;
}
export const runConfigSchema = z.strictObject({
  origin: z.string().transform(origin),
  game: gameSchema,
  profiles: z
    .array(profileNameSchema)
    .min(1)
    .max(4)
    .refine((p) => new Set(p).size === p.length),
  target: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("room"), roomId: z.string().regex(/^\d{5}$/) }),
    z.strictObject({
      type: z.literal("create"),
      timeControl: roomTimeControlSchema.default({ mainTimeMs: 300000, byoyomiMs: 30000 }),
      threePlayerAttackProhibited: z.boolean().default(true),
    }),
    z.strictObject({ type: z.literal("tournament"), id: z.int().positive() }),
    z.strictObject({ type: z.literal("rated") }),
  ]),
});
export type RunConfig = z.infer<typeof runConfigSchema>;
export type Game = z.infer<typeof gameSchema>;
export function scope(config: RunConfig): string {
  return JSON.stringify([config.game, config.target]);
}
export type Log = (event: string, details?: Record<string, string | number | boolean>) => void;
export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
