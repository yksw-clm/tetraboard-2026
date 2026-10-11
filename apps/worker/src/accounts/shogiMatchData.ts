import { z } from "zod";
import {
  shogiMatchDetailSchema,
  shogiMatchSummarySchema,
  shogiMatchParticipantSchema,
  shogiAccountStatsSchema,
  reversiRankingsSchema,
} from "@tetraboard/protocol";
import type { StandardShogiMatchRecord } from "../rooms/shogiMatchStore";
import type { ParticipantProfiles } from "./matchProfiles";
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
  .strictObject({ ...shogiMatchDetailSchema.shape, instanceId: z.uuid(), participants })
  .omit({ selfPlayerId: true });
function publicPlayers(record: StandardShogiMatchRecord, profiles: ParticipantProfiles) {
  return record.participants.map((p) => {
    const identity = p.kind === "human" && p.accountId ? profiles.get(p.accountId) : undefined;
    return {
      id: p.id,
      side: p.side,
      seat: p.seat,
      name: identity?.name ?? p.name,
      ...(p.kind === "human" && p.retired ? { retired: true } : {}),
      ...(p.kind === "cpu"
        ? { kind: p.kind, level: p.level }
        : { kind: p.kind, avatarUrl: identity?.avatarUrl ?? null }),
    };
  });
}
function detail(
  record: StandardShogiMatchRecord,
  selfPlayerId: string,
  profiles: ParticipantProfiles,
) {
  const { instanceId: _instance, ...data } = record;
  return shogiMatchDetailSchema.parse({
    ...data,
    selfPlayerId,
    participants: publicPlayers(record, profiles),
  });
}
export const shogiMatchData = {
  read(json: string): StandardShogiMatchRecord {
    const record = recordSchema.parse(JSON.parse(json));
    detail(record, record.participants[0].id, new Map());
    return record;
  },
  detail,
  summary(record: StandardShogiMatchRecord, profiles: ParticipantProfiles) {
    return shogiMatchSummarySchema.parse({
      id: record.id,
      game: "shogi",
      startedAtMs: record.startedAtMs,
      endedAtMs: record.endedAtMs,
      participants: publicPlayers(record, profiles),
      result: record.game.result,
    });
  },
  stats: (value: unknown) => shogiAccountStatsSchema.parse(value),
  rankings: (value: unknown) => reversiRankingsSchema.parse(value),
};
