import { eventReplaySchema, isEventReplay, type StoredRecord } from "../rooms/eventRecord";
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
function publicPlayers(record: Omit<MatchRecord, "replay">, profiles: ParticipantProfiles) {
  return record.participants.map((p) => {
    const identity = p.kind === "human" && p.accountId ? profiles.get(p.accountId) : undefined;
    return {
      id: p.id,
      color: p.color,
      seat: p.seat,
      name: identity?.name ?? p.name,
      ...(p.kind === "human" && p.retired ? { retired: true } : {}),
      ...(p.kind === "cpu"
        ? { kind: p.kind, level: p.level }
        : { kind: p.kind, avatarUrl: identity?.avatarUrl ?? null }),
    };
  });
}
function detail(record: MatchRecord, selfPlayerId: string, profiles: ParticipantProfiles) {
  const {
    instanceId: _instance,
    aiFallback: _aiFallback,
    rating: _rating,
    profileRatings: _profileRatings,
    ...data
  } = record;
  return reversiMatchDetailSchema.parse({
    ...data,
    selfPlayerId,
    participants: publicPlayers(record, profiles),
  });
}
const storedRecordSchema = recordSchema.extend({
  replay: z.union([recordSchema.shape.replay, eventReplaySchema(recordSchema.shape.replay)]),
});
export const reversiMatchData = {
  readStored(json: string): StoredRecord<MatchRecord> {
    const value = storedRecordSchema.parse(JSON.parse(json));
    return isEventReplay(value.replay) ? value : this.read(json);
  },
  read(json: string): MatchRecord {
    const record = recordSchema.parse(JSON.parse(json));
    detail(record, record.participants[0].id, new Map());
    return record;
  },
  detail,
  summary(record: Omit<MatchRecord, "replay">, profiles: ParticipantProfiles) {
    return reversiMatchSummarySchema.parse({
      id: record.id,
      game: "reversi",
      startedAtMs: record.startedAtMs,
      endedAtMs: record.endedAtMs,
      participants: publicPlayers(record, profiles),
      result: record.game.result,
    });
  },
  stats: (value: unknown) => reversiAccountStatsSchema.parse(value),
  rankings: (value: unknown) => reversiRankingsSchema.parse(value),
};
