import {
  matchDetail as formatDetail,
  matchSummary as formatSummary,
} from "@tetraboard/context-record";
import { eventReplaySchema, type StoredRecord } from "./eventRecord";
import { replayV1, sameState } from "@tetraboard/four-gomoku/replay";
import { z } from "zod";
import {
  fourGomokuMatchDetailSchema,
  fourGomokuMatchSummarySchema,
  fourGomokuMatchParticipantSchema,
  fourGomokuAccountStatsSchema,
  fourReversiRankingsSchema,
} from "@tetraboard/protocol";
import type { MatchRecord } from "./fourGomokuMatchStore";
import type { ParticipantProfiles } from "@tetraboard/context-record";
const participants = z
  .array(
    z.discriminatedUnion("kind", [
      fourGomokuMatchParticipantSchema.options[0]
        .omit({ avatarUrl: true })
        .extend({ accountId: z.string().min(1).nullable() }),
      fourGomokuMatchParticipantSchema.options[1],
    ]),
  )
  .length(4);
const recordSchema = z
  .strictObject({ ...fourGomokuMatchDetailSchema.shape, instanceId: z.uuid(), participants })
  .omit({ selfPlayerId: true, matchKind: true });
function detail(record: MatchRecord, selfPlayerId: string, profiles: ParticipantProfiles) {
  return fourGomokuMatchDetailSchema.parse(
    formatDetail({ game: "four-gomoku", record }, selfPlayerId, profiles),
  );
}
const storedRecordSchema = recordSchema.extend({
  replay: eventReplaySchema(recordSchema.shape.replay),
});
export const fourGomokuMatchData = {
  readStored(json: string): StoredRecord<MatchRecord> {
    return storedRecordSchema.parse(JSON.parse(json));
  },
  read(json: string): MatchRecord {
    const record = recordSchema.parse(JSON.parse(json));
    detail(record, record.participants[0].id, new Map());
    const eliminated = record.replay.steps.flatMap(({ action }) =>
      action.type === "eliminate" ? [[action.color, action.reason]] : [],
    );
    if (
      JSON.stringify(eliminated) !==
      JSON.stringify(record.eliminations.map((e) => [e.color, e.reason]))
    )
      throw new Error("Invalid Four Gomoku eliminations");
    const frames = replayV1(record.replay);
    if (!sameState(frames.at(-1)!, record.game)) throw new Error("Invalid FourGomoku final state");
    return record;
  },
  detail,
  summary(record: Omit<MatchRecord, "replay">, profiles: ParticipantProfiles) {
    return fourGomokuMatchSummarySchema.parse(
      formatSummary({ game: "four-gomoku", record }, profiles),
    );
  },
  stats: (value: unknown) => fourGomokuAccountStatsSchema.parse(value),
  rankings: (value: unknown) => fourReversiRankingsSchema.parse(value),
};
