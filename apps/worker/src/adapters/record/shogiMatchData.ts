import {
  matchDetail as formatDetail,
  matchSummary as formatSummary,
} from "@tetraboard/context-record";
import { profileRatingsSchema } from "@tetraboard/protocol";
import { z } from "zod";
import {
  shogiMatchDetailSchema,
  shogiMatchSummarySchema,
  shogiMatchParticipantSchema,
  shogiAccountStatsSchema,
  reversiRankingsSchema,
} from "@tetraboard/protocol";
import type { StandardShogiMatchRecord } from "../../rooms/shogiMatchStore";
import { shogiRatingSourceSchema } from "../../rooms/shogiRating";
import type { ParticipantProfiles } from "@tetraboard/context-record";
const participants = z
  .array(
    z.discriminatedUnion("kind", [
      shogiMatchParticipantSchema.options[0]
        .omit({ avatarUrl: true })
        .extend({ accountId: z.string().min(1).nullable() }),
      shogiMatchParticipantSchema.options[1],
    ]),
  )
  .length(2);
const recordSchema = z
  .strictObject({
    ...shogiMatchDetailSchema.shape,
    instanceId: z.uuid(),
    profileRatings: profileRatingsSchema.optional(),
    participants,
    rating: shogiRatingSourceSchema.optional(),
  })
  .omit({ selfPlayerId: true, matchKind: true });
function detail(
  record: StandardShogiMatchRecord,
  selfPlayerId: string,
  profiles: ParticipantProfiles,
) {
  return shogiMatchDetailSchema.parse(
    formatDetail({ game: "shogi", record }, selfPlayerId, profiles),
  );
}
export const shogiMatchData = {
  read(json: string): StandardShogiMatchRecord {
    const record = recordSchema.parse(JSON.parse(json));
    detail(record, record.participants[0].id, new Map());
    return record;
  },
  detail,
  summary(record: StandardShogiMatchRecord, profiles: ParticipantProfiles) {
    return shogiMatchSummarySchema.parse(formatSummary({ game: "shogi", record }, profiles));
  },
  stats: (value: unknown) => shogiAccountStatsSchema.parse(value),
  rankings: (value: unknown) => reversiRankingsSchema.parse(value),
};
