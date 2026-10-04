import { z } from "zod";
import { type GameId } from "@tetraboard/protocol/games";
import {
  gameIdSchema,
  fourReversiMatchDetailSchema,
  fourShogiMatchDetailSchema,
  fourReversiMatchSummarySchema,
  fourShogiMatchSummarySchema,
  matchParticipantSchema,
  fourShogiMatchParticipantSchema,
  fourReversiAccountStatsSchema,
  fourShogiAccountStatsSchema,
  gameRankingContracts,
  type MatchFor,
  type RankingsFor,
  type FourReversiAccountStats,
  type FourShogiAccountStats,
  type FourReversiMatchSummary,
  type FourShogiMatchSummary,
} from "@tetraboard/protocol";
import type { MatchRecord } from "../rooms/matchStore";
import type { ShogiMatchRecord } from "../rooms/shogiMatchStore";

export interface MatchDataMap {
  "four-reversi": {
    record: MatchRecord;
    summary: FourReversiMatchSummary;
    stats: FourReversiAccountStats & {
      singles: FourReversiAccountStats["singles"] & { knockouts?: never };
    };
  };
  "four-shogi": {
    record: ShogiMatchRecord;
    summary: FourShogiMatchSummary;
    stats: FourShogiAccountStats;
  };
}
export type RecordFor<G extends GameId> = MatchDataMap[G]["record"];
export type StatsFor<G extends GameId> = MatchDataMap[G]["stats"];
export type MatchDataContract<G extends GameId> = {
  read: (json: string) => RecordFor<G>;
  detail: (
    record: RecordFor<G>,
    selfPlayerId: string,
    avatars: Map<string, string | null>,
  ) => MatchFor<G>;
  summary: (
    record: RecordFor<G>,
    avatars: Map<string, string | null>,
  ) => MatchDataMap[G]["summary"];
  stats: (value: unknown) => StatsFor<G>;
  rankings: (value: unknown) => RankingsFor<G>;
};
const accountId = z.string().min(1).nullable();
const reversiParticipants = z
  .array(
    z.discriminatedUnion("kind", [
      matchParticipantSchema.options[0].omit({ avatarUrl: true }).extend({ accountId }),
      matchParticipantSchema.options[1],
    ]),
  )
  .length(4);
const shogiParticipants = z
  .array(
    z.discriminatedUnion("kind", [
      fourShogiMatchParticipantSchema.options[0].omit({ avatarUrl: true }).extend({ accountId }),
      fourShogiMatchParticipantSchema.options[1],
    ]),
  )
  .length(4);
const reversiRecordSchema = z
  .strictObject({
    ...fourReversiMatchDetailSchema.shape,
    instanceId: z.uuid(),
    participants: reversiParticipants,
  })
  .omit({ selfPlayerId: true });
const shogiRecordSchema = z
  .strictObject({
    ...fourShogiMatchDetailSchema.shape,
    instanceId: z.uuid(),
    participants: shogiParticipants,
  })
  .omit({ selfPlayerId: true });
function publicIdentity(
  player: { kind: "human"; accountId: string | null } | { kind: "cpu"; level: 1 | 2 },
  avatars: Map<string, string | null>,
): { kind: "human"; avatarUrl: string | null } | { kind: "cpu"; level: 1 | 2 } {
  return player.kind === "human"
    ? {
        kind: "human",
        avatarUrl: player.accountId ? (avatars.get(player.accountId) ?? null) : null,
      }
    : { kind: "cpu", level: player.level };
}
function reversiPublic(record: MatchRecord, avatars: Map<string, string | null>) {
  return record.participants.map((p) => ({
    id: p.id,
    name: p.name,
    color: p.color,
    seat: p.seat,
    ...publicIdentity(p, avatars),
  }));
}
function shogiPublic(record: ShogiMatchRecord, avatars: Map<string, string | null>) {
  return record.participants.map((p) => ({
    id: p.id,
    name: p.name,
    side: p.side,
    seat: p.seat,
    ...publicIdentity(p, avatars),
  }));
}
function reversiDetail(
  record: MatchRecord,
  selfPlayerId: string,
  avatars: Map<string, string | null>,
) {
  const { instanceId: _instance, ...data } = record;
  return fourReversiMatchDetailSchema.parse({
    ...data,
    selfPlayerId,
    participants: reversiPublic(record, avatars),
  });
}
function shogiDetail(
  record: ShogiMatchRecord,
  selfPlayerId: string,
  avatars: Map<string, string | null>,
) {
  const { instanceId: _instance, ...data } = record;
  return fourShogiMatchDetailSchema.parse({
    ...data,
    selfPlayerId,
    participants: shogiPublic(record, avatars),
  });
}
export function readFourReversiMatchRecord(json: string): MatchRecord {
  const value: unknown = JSON.parse(json);
  const record = reversiRecordSchema.parse(value);
  reversiDetail(record, record.participants[0].id, new Map());
  return record;
}
export function readFourShogiMatchRecord(json: string): ShogiMatchRecord {
  const value: unknown = JSON.parse(json);
  const record = shogiRecordSchema.parse(value);
  shogiDetail(record, record.participants[0].id, new Map());
  if (record.settings.mode === "doubles" && Object.values(record.knockouts).some((n) => n !== 0))
    throw new Error("Doubles match cannot contain knockouts");
  return record;
}
export const matchDataContracts = {
  "four-reversi": {
    read: readFourReversiMatchRecord,
    detail: reversiDetail,
    summary: (record: MatchRecord, avatars: Map<string, string | null>) =>
      fourReversiMatchSummarySchema.parse({
        id: record.id,
        game: record.settings.game,
        mode: record.settings.mode,
        startedAtMs: record.startedAtMs,
        endedAtMs: record.endedAtMs,
        participants: reversiPublic(record, avatars),
        result: record.game.result,
      }),
    stats: (value: unknown) => fourReversiAccountStatsSchema.parse(value),
    rankings: (value: unknown) => gameRankingContracts["four-reversi"].response.parse(value),
  },
  "four-shogi": {
    read: readFourShogiMatchRecord,
    detail: shogiDetail,
    summary: (record: ShogiMatchRecord, avatars: Map<string, string | null>) =>
      fourShogiMatchSummarySchema.parse({
        id: record.id,
        game: record.settings.game,
        mode: record.settings.mode,
        startedAtMs: record.startedAtMs,
        endedAtMs: record.endedAtMs,
        participants: shogiPublic(record, avatars),
        result: record.game.result,
      }),
    stats: (value: unknown) => fourShogiAccountStatsSchema.parse(value),
    rankings: (value: unknown) => gameRankingContracts["four-shogi"].response.parse(value),
  },
} satisfies { [G in GameId]: MatchDataContract<G> };
export type DecodedMatch = { [G in GameId]: { game: G; record: RecordFor<G> } }[GameId];
const storedGameSchema = z.object({ settings: z.object({ game: gameIdSchema }) });
export function readStoredMatch(json: string, expectedGame: unknown): DecodedMatch {
  const value: unknown = JSON.parse(json);
  const game = storedGameSchema.parse(value).settings.game;
  if (game !== expectedGame) throw new Error("Stored match game mismatch");
  switch (game) {
    case "four-reversi":
      return { game, record: matchDataContracts[game].read(json) };
    case "four-shogi":
      return { game, record: matchDataContracts[game].read(json) };
    default: {
      const exhaustive: never = game;
      throw new Error(`Unsupported match game: ${exhaustive}`);
    }
  }
}
export function matchSummary(match: DecodedMatch, avatars: Map<string, string | null>) {
  switch (match.game) {
    case "four-reversi":
      return matchDataContracts[match.game].summary(match.record, avatars);
    case "four-shogi":
      return matchDataContracts[match.game].summary(match.record, avatars);
    default: {
      const exhaustive: never = match;
      throw new Error(`Unsupported match: ${exhaustive}`);
    }
  }
}
export function matchDetail(
  match: DecodedMatch,
  selfPlayerId: string,
  avatars: Map<string, string | null>,
) {
  switch (match.game) {
    case "four-reversi":
      return matchDataContracts[match.game].detail(match.record, selfPlayerId, avatars);
    case "four-shogi":
      return matchDataContracts[match.game].detail(match.record, selfPlayerId, avatars);
    default: {
      const exhaustive: never = match;
      throw new Error(`Unsupported match: ${exhaustive}`);
    }
  }
}
