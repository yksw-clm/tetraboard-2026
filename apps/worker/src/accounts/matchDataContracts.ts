import { fourGomokuMatchData } from "./fourGomokuMatchData";
import type { MatchRecord as FourGomokuMatchRecord } from "../rooms/fourGomokuMatchStore";
import type { FourGomokuMatchSummary, FourGomokuAccountStats } from "@tetraboard/protocol";
import { gomokuMatchData } from "./gomokuMatchData";
import type { MatchRecord as GomokuMatchRecord } from "../rooms/gomokuMatchStore";
import type { GomokuMatchSummary, GomokuAccountStats } from "@tetraboard/protocol";
import { shogiMatchData } from "./shogiMatchData";
import type { StandardShogiMatchRecord } from "../rooms/shogiMatchStore";
import type { ShogiMatchSummary, ShogiAccountStats } from "@tetraboard/protocol";
import { reversiMatchData } from "./reversiMatchData";
import type { MatchRecord as ReversiMatchRecord } from "../rooms/reversiMatchStore";
import type { ReversiAccountStats, ReversiMatchSummary } from "@tetraboard/protocol";
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
import type { ParticipantProfiles } from "./matchProfiles";
import type { MatchRecord } from "../rooms/matchStore";
import type { ShogiMatchRecord } from "../rooms/shogiMatchStore";

export interface MatchDataMap {
  "four-gomoku": {
    record: FourGomokuMatchRecord;
    summary: FourGomokuMatchSummary;
    stats: FourGomokuAccountStats;
  };
  shogi: { record: StandardShogiMatchRecord; summary: ShogiMatchSummary; stats: ShogiAccountStats };
  gomoku: { record: GomokuMatchRecord; summary: GomokuMatchSummary; stats: GomokuAccountStats };
  reversi: { record: ReversiMatchRecord; summary: ReversiMatchSummary; stats: ReversiAccountStats };
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
    profiles: ParticipantProfiles,
  ) => MatchFor<G>;
  summary: (record: RecordFor<G>, profiles: ParticipantProfiles) => MatchDataMap[G]["summary"];
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
  player: { name: string } & (
    | { kind: "human"; accountId: string | null }
    | { kind: "cpu"; level: 1 | 2 }
  ),
  profiles: ParticipantProfiles,
):
  | { name: string; kind: "human"; avatarUrl: string | null }
  | { name: string; kind: "cpu"; level: 1 | 2 } {
  if (player.kind === "cpu") return { name: player.name, kind: "cpu", level: player.level };
  const profile = player.accountId ? profiles.get(player.accountId) : undefined;
  return {
    name: profile?.name ?? player.name,
    kind: "human",
    avatarUrl: profile?.avatarUrl ?? null,
  };
}
function reversiPublic(record: MatchRecord, profiles: ParticipantProfiles) {
  return record.participants.map((p) => ({
    id: p.id,
    color: p.color,
    seat: p.seat,
    ...publicIdentity(p, profiles),
  }));
}
function shogiPublic(record: ShogiMatchRecord, profiles: ParticipantProfiles) {
  return record.participants.map((p) => ({
    id: p.id,
    side: p.side,
    seat: p.seat,
    ...publicIdentity(p, profiles),
  }));
}
function reversiDetail(record: MatchRecord, selfPlayerId: string, profiles: ParticipantProfiles) {
  const { instanceId: _instance, ...data } = record;
  return fourReversiMatchDetailSchema.parse({
    ...data,
    selfPlayerId,
    participants: reversiPublic(record, profiles),
  });
}
function shogiDetail(
  record: ShogiMatchRecord,
  selfPlayerId: string,
  profiles: ParticipantProfiles,
) {
  const { instanceId: _instance, ...data } = record;
  return fourShogiMatchDetailSchema.parse({
    ...data,
    selfPlayerId,
    participants: shogiPublic(record, profiles),
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
  "four-gomoku": fourGomokuMatchData,
  shogi: shogiMatchData,
  reversi: reversiMatchData,
  gomoku: gomokuMatchData,
  "four-reversi": {
    read: readFourReversiMatchRecord,
    detail: reversiDetail,
    summary: (record: MatchRecord, profiles: ParticipantProfiles) =>
      fourReversiMatchSummarySchema.parse({
        id: record.id,
        game: record.settings.game,
        mode: record.settings.mode,
        startedAtMs: record.startedAtMs,
        endedAtMs: record.endedAtMs,
        participants: reversiPublic(record, profiles),
        result: record.game.result,
      }),
    stats: (value: unknown) => fourReversiAccountStatsSchema.parse(value),
    rankings: (value: unknown) => gameRankingContracts["four-reversi"].response.parse(value),
  },
  "four-shogi": {
    read: readFourShogiMatchRecord,
    detail: shogiDetail,
    summary: (record: ShogiMatchRecord, profiles: ParticipantProfiles) =>
      fourShogiMatchSummarySchema.parse({
        id: record.id,
        game: record.settings.game,
        mode: record.settings.mode,
        startedAtMs: record.startedAtMs,
        endedAtMs: record.endedAtMs,
        participants: shogiPublic(record, profiles),
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
    case "shogi":
      return { game, record: matchDataContracts[game].read(json) };
    case "reversi":
      return { game, record: matchDataContracts[game].read(json) };
    case "four-gomoku":
      return { game, record: matchDataContracts[game].read(json) };
    case "gomoku":
      return { game, record: matchDataContracts[game].read(json) };
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
export function matchSummary(match: DecodedMatch, profiles: ParticipantProfiles) {
  switch (match.game) {
    case "shogi":
      return matchDataContracts[match.game].summary(match.record, profiles);
    case "reversi":
      return matchDataContracts[match.game].summary(match.record, profiles);
    case "four-gomoku":
      return matchDataContracts[match.game].summary(match.record, profiles);
    case "gomoku":
      return matchDataContracts[match.game].summary(match.record, profiles);
    case "four-reversi":
      return matchDataContracts[match.game].summary(match.record, profiles);
    case "four-shogi":
      return matchDataContracts[match.game].summary(match.record, profiles);
    default: {
      const exhaustive: never = match;
      throw new Error(`Unsupported match: ${exhaustive}`);
    }
  }
}
export function matchDetail(
  match: DecodedMatch,
  selfPlayerId: string,
  profiles: ParticipantProfiles,
) {
  switch (match.game) {
    case "shogi":
      return matchDataContracts[match.game].detail(match.record, selfPlayerId, profiles);
    case "reversi":
      return matchDataContracts[match.game].detail(match.record, selfPlayerId, profiles);
    case "four-gomoku":
      return matchDataContracts[match.game].detail(match.record, selfPlayerId, profiles);
    case "gomoku":
      return matchDataContracts[match.game].detail(match.record, selfPlayerId, profiles);
    case "four-reversi":
      return matchDataContracts[match.game].detail(match.record, selfPlayerId, profiles);
    case "four-shogi":
      return matchDataContracts[match.game].detail(match.record, selfPlayerId, profiles);
    default: {
      const exhaustive: never = match;
      throw new Error(`Unsupported match: ${exhaustive}`);
    }
  }
}

export function publicMatchDetail(match: DecodedMatch, profiles: ParticipantProfiles) {
  const { selfPlayerId: _self, ...detail } = matchDetail(
    match,
    match.record.participants[0].id,
    profiles,
  );
  return detail;
}
