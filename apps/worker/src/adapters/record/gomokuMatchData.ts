import {
  matchDetail as formatDetail,
  matchSummary as formatSummary,
} from "@tetraboard/context-record";
import { eventReplaySchema, type StoredRecord } from "./eventRecord";
import { replayV1, sameState } from "@tetraboard/gomoku/replay";
import { z } from "zod";
import {
  gomokuMatchDetailSchema,
  gomokuMatchSummarySchema,
  gomokuMatchParticipantSchema,
  gomokuAccountStatsSchema,
  reversiRankingsSchema,
} from "@tetraboard/protocol";
import type { MatchRecord } from "./gomokuMatchStore";
import type { ParticipantProfiles } from "@tetraboard/context-record";
const participants = z
  .array(
    z.discriminatedUnion("kind", [
      gomokuMatchParticipantSchema.options[0]
        .omit({ avatarUrl: true })
        .extend({ accountId: z.string().min(1).nullable() }),
      gomokuMatchParticipantSchema.options[1],
    ]),
  )
  .length(2);
const recordSchema = z
  .strictObject({ ...gomokuMatchDetailSchema.shape, instanceId: z.uuid(), participants })
  .omit({ selfPlayerId: true, matchKind: true });
function detail(record: MatchRecord, selfPlayerId: string, profiles: ParticipantProfiles) {
  return gomokuMatchDetailSchema.parse(
    formatDetail({ game: "gomoku", record }, selfPlayerId, profiles),
  );
}
const storedRecordSchema = recordSchema.extend({
  replay: eventReplaySchema(recordSchema.shape.replay),
});
export const gomokuMatchData = {
  readStored(json: string): StoredRecord<MatchRecord> {
    return storedRecordSchema.parse(JSON.parse(json));
  },
  read(json: string): MatchRecord {
    const record = recordSchema.parse(JSON.parse(json));
    detail(record, record.participants[0].id, new Map());
    const frames = replayV1(record.replay);
    if (!sameState(frames.at(-1)!, record.game)) throw new Error("Invalid Gomoku final state");
    return record;
  },
  detail,
  summary(record: Omit<MatchRecord, "replay">, profiles: ParticipantProfiles) {
    return gomokuMatchSummarySchema.parse(formatSummary({ game: "gomoku", record }, profiles));
  },
  stats: (value: unknown) => gomokuAccountStatsSchema.parse(value),
  rankings: (value: unknown) => reversiRankingsSchema.parse(value),
};
