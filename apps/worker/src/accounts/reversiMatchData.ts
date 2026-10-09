import { z } from "zod";
import {
  reversiMatchDetailSchema,
  reversiMatchSummarySchema,
  reversiMatchParticipantSchema,
  reversiAccountStatsSchema,
  reversiRankingsSchema,
} from "@tetraboard/protocol";
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
  .strictObject({ ...reversiMatchDetailSchema.shape, instanceId: z.uuid(), participants })
  .omit({ selfPlayerId: true });
function publicPlayers(record: MatchRecord, profiles: ParticipantProfiles) {
  return record.participants.map((p) => {
    const identity = p.kind === "human" && p.accountId ? profiles.get(p.accountId) : undefined;
    return {
      id: p.id,
      color: p.color,
      seat: p.seat,
      name: identity?.name ?? p.name,
      ...(p.kind === "cpu"
        ? { kind: p.kind, level: p.level }
        : { kind: p.kind, avatarUrl: identity?.avatarUrl ?? null }),
    };
  });
}
function detail(record: MatchRecord, selfPlayerId: string, profiles: ParticipantProfiles) {
  const { instanceId: _instance, ...data } = record;
  return reversiMatchDetailSchema.parse({
    ...data,
    selfPlayerId,
    participants: publicPlayers(record, profiles),
  });
}
export const reversiMatchData = {
  read(json: string): MatchRecord {
    const record = recordSchema.parse(JSON.parse(json));
    detail(record, record.participants[0].id, new Map());
    return record;
  },
  detail,
  summary(record: MatchRecord, profiles: ParticipantProfiles) {
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
