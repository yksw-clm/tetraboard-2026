import { z } from "zod";

export const tournamentRules = {
  version: 1,
  game: "four-shogi",
  mode: "singles",
  mainTimeMs: 0,
  byoyomiMs: 30_000,
  threePlayerAttackProhibited: true,
  agreementDrawAllowed: false,
  pointsUnits: [48, 24, 12, 0],
  pointUnit: 12,
  entryDelayMs: 5_000,
  startCountdownMs: 5_000,
  connectionGraceMs: 30_000,
  heartbeatMs: 10_000,
  leaseMs: 30_000,
} as const;
export const tournamentFixedRules = [
  "四人将棋・シングルス、人間4人のランダムマッチです。CPU補充はありません。",
  "持ち時間なし・秒読み30秒、三人攻撃禁止ONで対局します。",
  "1位4点・2位2点・3位1点・4位0点の累計で大会順位を決めます。",
  "同順位は、占める順位の勝ち点を均等に分けます。合意による引き分けは使いません。",
  "勝ち点が同じ場合は撃破数の多い順、平均順位がよい順で比較し、すべて同じなら同順位です。",
  "開催時間内に始まった大会対局は終了時刻を過ぎても得点対象とし、終了と保存を待って結果を確定します。",
] as const;

const text = (minimum: number, maximum: number) =>
  z
    .string()
    .transform((value) => value.replace(/\r\n?/g, "\n").trim())
    .refine((value) => Array.from(value).length >= minimum && Array.from(value).length <= maximum, {
      message: `${minimum}〜${maximum}文字で入力してください。`,
    });
const timestamp = z.number().int().nonnegative();
const count = z.number().int().nonnegative();
export const tournamentIdSchema = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const tournamentStageSchema = z.enum(["upcoming", "active", "settling", "finished"]);
export type TournamentStage = z.infer<typeof tournamentStageSchema>;
const inputFields = {
  name: text(1, 80),
  description: text(0, 2000),
  rulesDescription: text(0, 2000),
  startsAtMs: timestamp.nullable(),
  endsAtMs: timestamp.nullable(),
};
export const tournamentInputSchema = z
  .strictObject(inputFields)
  .refine(
    (input) =>
      input.startsAtMs === null || input.endsAtMs === null || input.startsAtMs < input.endsAtMs,
    { message: "終了日時は開始日時より後にしてください。", path: ["endsAtMs"] },
  );
export type TournamentInput = z.infer<typeof tournamentInputSchema>;
export const tournamentPatchSchema = z.strictObject({ ...inputFields, version: count });
export const tournamentPublishSchema = z.strictObject({ version: count });
export const tournamentPublicSchema = z.strictObject({
  id: tournamentIdSchema,
  name: z.string(),
  description: z.string(),
  rulesDescription: z.string(),
  startsAtMs: timestamp,
  endsAtMs: timestamp,
  status: tournamentStageSchema,
  entryCount: count,
  waitingCount: count,
  playingCount: count,
  pendingCount: count,
  completedCount: count,
  ruleVersion: z.literal(1),
  finalizedAtMs: timestamp.nullable(),
});
export type TournamentPublic = z.infer<typeof tournamentPublicSchema>;
export const tournamentStandingSchema = z.strictObject({
  rank: z.number().int().positive().nullable(),
  username: z.string().nullable(),
  name: z.string(),
  avatarUrl: z.string().nullable(),
  pointsUnits: count,
  games: count,
  first: count,
  second: count,
  third: count,
  fourth: count,
  knockouts: count,
  rankSum: count,
  self: z.boolean().optional(),
});
export type TournamentStanding = z.infer<typeof tournamentStandingSchema>;
export const tournamentStandingsSchema = z.strictObject({
  standings: z.array(tournamentStandingSchema),
  self: tournamentStandingSchema.nullable(),
  nextCursor: z.string().nullable(),
});
export const tournamentDetailSchema = tournamentStandingsSchema.extend({
  tournament: tournamentPublicSchema,
  nextTournament: tournamentPublicSchema.nullable(),
});
export type TournamentDetail = z.infer<typeof tournamentDetailSchema>;
export const tournamentLobbySchema = z.strictObject({
  tournament: tournamentPublicSchema.nullable(),
});
export const tournamentParticipationSchema = z.strictObject({
  entered: z.boolean(),
  status: z.enum(["idle", "waiting", "matched", "playing"]),
  controller: z.enum(["self", "other", "none"]),
  controllerVersion: count,
  operationId: z.uuid().optional(),
  matchId: z.uuid().optional(),
  expiresAtMs: timestamp.optional(),
  roomId: z.string().optional(),
  instanceId: z.uuid().optional(),
});
export type TournamentParticipation = z.infer<typeof tournamentParticipationSchema>;
export const tournamentQueueInputSchema = z.strictObject({
  operationId: z.uuid(),
  token: z.string().regex(/^[0-9a-f]{64}$/),
  controllerId: z.uuid(),
});
export const tournamentOperationSchema = z.strictObject({
  operationId: z.uuid(),
  controllerId: z.uuid(),
  controllerVersion: count,
});
export const tournamentControllerInputSchema = z.strictObject({
  operationId: z.uuid(),
  controllerId: z.uuid(),
  takeover: z.boolean(),
  expectedControllerVersion: count,
});
export const tournamentControllerResponseSchema = z.strictObject({
  participation: tournamentParticipationSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/),
});
export const tournamentConfirmationSchema = z.strictObject({
  operationId: z.uuid(),
  matchId: z.uuid(),
  accept: z.boolean(),
});
export const tournamentRecordSchema = z.strictObject({
  key: z.uuid(),
  id: tournamentIdSchema.nullable(),
  ...inputFields,
  published: z.boolean(),
  version: count,
  ruleVersion: z.literal(1),
  createdAtMs: timestamp,
  updatedAtMs: timestamp,
  entryCount: count,
  status: z.enum(["draft", "upcoming", "active", "settling", "finished"]),
});
export type TournamentRecord = z.infer<typeof tournamentRecordSchema>;
export const tournamentAdminListSchema = z.strictObject({
  tournaments: z.array(tournamentRecordSchema),
  nextCursor: z.string().nullable(),
});
export const tournamentAdminEntrySchema = z.strictObject({
  name: z.string(),
  username: z.string(),
  avatarUrl: z.string().nullable(),
  enteredAtMs: timestamp,
  status: z.enum(["idle", "waiting", "matched", "playing"]),
  games: count,
  pointsUnits: count,
  knockouts: count,
  rank: z.number().int().positive().nullable(),
});
export type TournamentAdminEntry = z.infer<typeof tournamentAdminEntrySchema>;
export const tournamentAdminEntriesSchema = z.strictObject({
  entries: z.array(tournamentAdminEntrySchema),
  total: count,
  nextCursor: z.string().nullable(),
});

export function tournamentRankPointsUnits(rank: number, tiedCount = 1): number {
  if (
    !Number.isInteger(rank) ||
    !Number.isInteger(tiedCount) ||
    rank < 1 ||
    tiedCount < 1 ||
    rank + tiedCount > 5
  )
    throw new RangeError("順位と同順位人数が正しくありません。");
  return (
    tournamentRules.pointsUnits
      .slice(rank - 1, rank - 1 + tiedCount)
      .reduce<number>((sum, value) => sum + value, 0) / tiedCount
  );
}
export function compareTournamentScores(a: TournamentStanding, b: TournamentStanding): number {
  return (
    Number(b.games > 0) - Number(a.games > 0) ||
    b.pointsUnits - a.pointsUnits ||
    b.knockouts - a.knockouts ||
    a.rankSum * b.games - b.rankSum * a.games
  );
}
export function rankTournamentStandings<T extends TournamentStanding>(values: T[]): T[] {
  const sorted = [...values].sort(
    (a, b) => compareTournamentScores(a, b) || (a.username ?? "").localeCompare(b.username ?? ""),
  );
  let rank = 0;
  return sorted.map((row, index) => {
    if (row.games && (index === 0 || compareTournamentScores(sorted[index - 1]!, row) !== 0))
      rank = index + 1;
    return { ...row, rank: row.games ? rank : null };
  });
}
export function formatTournamentPoints(units: number): string {
  return (units / tournamentRules.pointUnit).toFixed(2).replace(/\.?0+$/, "") || "0";
}
