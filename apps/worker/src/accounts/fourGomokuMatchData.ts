import { replayV1, sameState } from "@tetraboard/four-gomoku/replay";
import { z } from "zod";
import {
  fourGomokuMatchDetailSchema,
  fourGomokuMatchSummarySchema,
  fourGomokuMatchParticipantSchema,
  fourGomokuAccountStatsSchema,
  fourReversiRankingsSchema,
} from "@tetraboard/protocol";
import type { MatchRecord } from "../rooms/fourGomokuMatchStore";
import type { ParticipantProfiles } from "./matchProfiles";
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
  .omit({ selfPlayerId: true });
function publicPlayers(record: MatchRecord, profiles: ParticipantProfiles) {
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
  return fourGomokuMatchDetailSchema.parse({
    ...data,
    selfPlayerId,
    participants: publicPlayers(record, profiles),
  });
}
export const fourGomokuMatchData = {
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
  summary(record: MatchRecord, profiles: ParticipantProfiles) {
    return fourGomokuMatchSummarySchema.parse({
      id: record.id,
      game: "four-gomoku",
      mode: record.settings.mode,
      startedAtMs: record.startedAtMs,
      endedAtMs: record.endedAtMs,
      participants: publicPlayers(record, profiles),
      result: record.game.result,
    });
  },
  stats: (value: unknown) => fourGomokuAccountStatsSchema.parse(value),
  rankings: (value: unknown) => fourReversiRankingsSchema.parse(value),
};
