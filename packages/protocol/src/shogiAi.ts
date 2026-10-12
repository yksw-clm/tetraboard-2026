import { z } from "zod";
export const aiProfileSchema = z.enum(["singles-restricted", "singles-unrestricted"]);
export type AiProfile = z.infer<typeof aiProfileSchema>;
const count = z.int().nonnegative();
const timestamp = z.int().nonnegative();
const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const aiWeightsSchema = z.strictObject({
  undefended: z.number().min(0).max(5),
  exchange: z.number().min(0).max(5),
  kingRing: z.number().min(0).max(200),
  check: z.number().min(0).max(500),
  mobility: z.number().min(0).max(20),
  advancement: z.number().min(0).max(40),
  shelter: z.number().min(0).max(100),
  survival: z.number().min(1000).max(10000),
});
export const aiModelSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: identifier,
  profileId: aiProfileSchema,
  generation: count,
  parentId: identifier.nullable(),
  codeCommit: z.string().min(1).max(80),
  sourceHash: digest,
  createdAt: timestamp,
  weights: aiWeightsSchema,
  maxWork: z.int().min(128).max(262144),
});
export type AiModel = z.infer<typeof aiModelSchema>;
export const aiMetricsSchema = z.strictObject({
  games: count,
  wins: count,
  draws: count,
  unfinished: count,
  averageRank: z.number().min(1).max(4).nullable(),
  winRate: z.number().min(0).max(1).nullable(),
  winInterval: z.tuple([z.number(), z.number()]).nullable(),
  reward: z.number().min(0).max(1).nullable(),
});
export const aiRunSchema = z.strictObject({
  id: identifier,
  profileId: aiProfileSchema,
  generation: count,
  stage: z.enum(["selfplay", "evaluating", "ready", "stopped", "failed"]),
  modelId: identifier,
  parentId: identifier,
  startedAt: timestamp,
  updatedAt: timestamp,
  completedGames: count,
  plannedGames: count,
  accepted: z.boolean(),
  differenceInterval: z.tuple([z.number(), z.number()]).nullable(),
  metrics: aiMetricsSchema,
  error: z.string().max(200).nullable(),
});
export type AiRun = z.infer<typeof aiRunSchema>;
export const aiRunsSchema = z.strictObject({
  runs: z.array(aiRunSchema).max(20),
  nextCursor: identifier.nullable(),
});
export const aiStatusSchema = z.strictObject({
  schemaVersion: z.literal(1),
  generatedAt: timestamp,
  heartbeatAt: timestamp,
  startedAt: timestamp,
  learningEndsAt: timestamp.nullable(),
  profiles: z
    .array(
      z.strictObject({
        profileId: aiProfileSchema,
        candidate: aiModelSchema.nullable(),
        champion: aiModelSchema,
        run: aiRunSchema.nullable(),
      }),
    )
    .length(2),
  learning: z.strictObject({
    stage: z.enum(["initialising", "selfplay", "evaluating", "ready", "stopped", "failed"]),
    games: count,
    gamesPerHour: z.number().nonnegative(),
    checkpointAt: timestamp.nullable(),
    activeGames: z
      .array(z.strictObject({ id: identifier, profileId: aiProfileSchema, ply: count }))
      .max(5),
  }),
  resources: z.strictObject({
    memoryBytes: count,
    scope: z.enum(["container", "controller"]),
    memoryLimitBytes: count.nullable(),
    cpuSeconds: z.number().nonnegative(),
    diskFreeBytes: count.nullable(),
  }),
  recentErrors: z.array(z.string().max(200)).max(10),
});
export type AiStatus = z.infer<typeof aiStatusSchema>;

const encoder = new TextEncoder();
export async function sha256(value: string): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
export async function signAiRequest(
  key: string,
  method: string,
  path: string,
  body: string,
  at: number,
  nonce: string,
): Promise<string> {
  const imported = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const payload = `${method}\n${path}\n${at}\n${nonce}\n${await sha256(body)}`;
  return Array.from(
    new Uint8Array(await crypto.subtle.sign("HMAC", imported, encoder.encode(payload))),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
