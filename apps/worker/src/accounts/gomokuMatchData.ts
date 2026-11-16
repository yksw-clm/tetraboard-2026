import { eventReplaySchema, isEventReplay, type StoredRecord } from "../rooms/eventRecord";
import { replayV1, sameState } from "@tetraboard/gomoku/replay";
import { z } from "zod";
import {
  gomokuMatchDetailSchema,
  gomokuMatchSummarySchema,
  gomokuMatchParticipantSchema,
  gomokuAccountStatsSchema,
  reversiRankingsSchema,
} from "@tetraboard/protocol";
import type { MatchRecord } from "../rooms/gomokuMatchStore";
import type { ParticipantProfiles } from "./matchProfiles";
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
  const { instanceId: _instance, ...data } = record;
  return gomokuMatchDetailSchema.parse({
    ...data,
    selfPlayerId,
    participants: publicPlayers(record, profiles),
  });
}
const storedRecordSchema = recordSchema.extend({
  replay: z.union([recordSchema.shape.replay, eventReplaySchema(recordSchema.shape.replay)]),
});
export const gomokuMatchData = {
  readStored(json: string): StoredRecord<MatchRecord> {
    const value = storedRecordSchema.parse(JSON.parse(json));
    return isEventReplay(value.replay) ? value : this.read(json);
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
    return gomokuMatchSummarySchema.parse({
      id: record.id,
      game: "gomoku",
      startedAtMs: record.startedAtMs,
      endedAtMs: record.endedAtMs,
      participants: publicPlayers(record, profiles),
      result: record.game.result,
    });
  },
  stats: (value: unknown) => gomokuAccountStatsSchema.parse(value),
  rankings: (value: unknown) => reversiRankingsSchema.parse(value),
};
