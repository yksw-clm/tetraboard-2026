import {
  matchDetail as formatDetail,
  matchSummary as formatSummary,
} from "@tetraboard/context-record";
import { eventReplaySchema, type StoredRecord } from "../rooms/eventRecord";
import { profileRatingsSchema } from "@tetraboard/protocol";
import { z } from "zod";
import {
  reversiMatchDetailSchema,
  reversiMatchSummarySchema,
  reversiMatchParticipantSchema,
  reversiAccountStatsSchema,
  reversiRankingsSchema,
} from "@tetraboard/protocol";
import { eloRatingSourceSchema } from "../rooms/eloRating";
import type { MatchRecord } from "../rooms/reversiMatchStore";
import type { ParticipantProfiles } from "./matchProfiles";
const participants = z
  .array(
    z.discriminatedUnion("kind", [
      reversiMatchParticipantSchema.options[0]
        .omit({ avatarUrl: true })
        .extend({ accountId: z.string().min(1).nullable() }),
      reversiMatchParticipantSchema.options[1],
    ]),
  )
  .length(2);
const recordSchema = z
  .strictObject({
    ...reversiMatchDetailSchema.shape,
    instanceId: z.uuid(),
    profileRatings: profileRatingsSchema.optional(),
    participants,
    aiFallback: z.literal(true).optional(),
    rating: eloRatingSourceSchema.optional(),
  })
  .omit({ selfPlayerId: true, matchKind: true });
function detail(record: MatchRecord, selfPlayerId: string, profiles: ParticipantProfiles) {
  return reversiMatchDetailSchema.parse(
    formatDetail({ game: "reversi", record }, selfPlayerId, profiles),
  );
}
const storedRecordSchema = recordSchema.extend({
  replay: eventReplaySchema(recordSchema.shape.replay),
});
export const reversiMatchData = {
  readStored(json: string): StoredRecord<MatchRecord> {
    return storedRecordSchema.parse(JSON.parse(json));
  },
  read(json: string): MatchRecord {
    const record = recordSchema.parse(JSON.parse(json));
    detail(record, record.participants[0].id, new Map());
    return record;
  },
  detail,
  summary(record: Omit<MatchRecord, "replay">, profiles: ParticipantProfiles) {
    return reversiMatchSummarySchema.parse(formatSummary({ game: "reversi", record }, profiles));
  },
  stats: (value: unknown) => reversiAccountStatsSchema.parse(value),
  rankings: (value: unknown) => reversiRankingsSchema.parse(value),
};
