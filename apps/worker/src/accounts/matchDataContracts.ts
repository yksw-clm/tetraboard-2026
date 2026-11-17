import {
  matchDetail as formatDetail,
  matchSummary as formatSummary,
} from "@tetraboard/context-record";
export { matchDetail, matchSummary, publicMatchDetail } from "@tetraboard/context-record";
import { eventReplaySchema, type StoredRecord } from "../rooms/eventRecord";
import { profileRatingsSchema } from "@tetraboard/protocol";
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
import { fourReversiRatedMatchSchema, fourShogiRatedMatchSchema } from "../rooms/fourReversiRating";
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
  readStored?: (
    json: string,
  ) => RecordFor<G> extends { replay: import("../rooms/eventRecord").SnapshotReplay }
    ? StoredRecord<RecordFor<G>>
    : RecordFor<G>;
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
    profileRatings: profileRatingsSchema.optional(),
    participants: reversiParticipants,
    fourReversiRating: fourReversiRatedMatchSchema.optional(),
  })
  .omit({ selfPlayerId: true, matchKind: true });
const shogiRecordSchema = z
  .strictObject({
    ...fourShogiMatchDetailSchema.shape,
    instanceId: z.uuid(),
    profileRatings: profileRatingsSchema.optional(),
    participants: shogiParticipants,
    fourShogiRating: fourShogiRatedMatchSchema.optional(),
  })
  .omit({ selfPlayerId: true, matchKind: true });
function reversiDetail(record: MatchRecord, selfPlayerId: string, profiles: ParticipantProfiles) {
  return fourReversiMatchDetailSchema.parse(
    formatDetail({ game: "four-reversi", record }, selfPlayerId, profiles),
  );
}
function shogiDetail(
  record: ShogiMatchRecord,
  selfPlayerId: string,
  profiles: ParticipantProfiles,
) {
  return fourShogiMatchDetailSchema.parse(
    formatDetail({ game: "four-shogi", record }, selfPlayerId, profiles),
  );
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
    readStored(json: string): StoredRecord<MatchRecord> {
      return reversiRecordSchema
        .extend({
          replay: eventReplaySchema(reversiRecordSchema.shape.replay),
        })
        .parse(JSON.parse(json));
    },
    detail: reversiDetail,
    summary: (record: Omit<MatchRecord, "replay">, profiles: ParticipantProfiles) =>
      fourReversiMatchSummarySchema.parse(
        formatSummary({ game: "four-reversi", record }, profiles),
      ),
    stats: (value: unknown) => fourReversiAccountStatsSchema.parse(value),
    rankings: (value: unknown) => gameRankingContracts["four-reversi"].response.parse(value),
  },
  "four-shogi": {
    read: readFourShogiMatchRecord,
    detail: shogiDetail,
    summary: (record: ShogiMatchRecord, profiles: ParticipantProfiles) =>
      fourShogiMatchSummarySchema.parse(formatSummary({ game: "four-shogi", record }, profiles)),
    stats: (value: unknown) => fourShogiAccountStatsSchema.parse(value),
    rankings: (value: unknown) => gameRankingContracts["four-shogi"].response.parse(value),
  },
} satisfies { [G in GameId]: MatchDataContract<G> };
export type DecodedMatch = {
  [G in GameId]: {
    game: G;
    record: RecordFor<G> extends { replay: import("../rooms/eventRecord").SnapshotReplay }
      ? StoredRecord<RecordFor<G>>
      : RecordFor<G>;
  };
}[GameId];
export type ReplayedMatch = {
  [G in GameId]: { game: G; record: RecordFor<G> };
}[GameId];
export type ReadableMatch = DecodedMatch | ReplayedMatch;
export function readMatchRecord(json: string, expectedGame: unknown): ReplayedMatch {
  const game = storedGameSchema.parse(JSON.parse(json)).settings.game;
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
  }
}
const storedGameSchema = z.object({ settings: z.object({ game: gameIdSchema }) });
export function readStoredMatch(json: string, expectedGame: unknown): DecodedMatch {
  const value: unknown = JSON.parse(json);
  const game = storedGameSchema.parse(value).settings.game;
  if (game !== expectedGame) throw new Error("Stored match game mismatch");
  switch (game) {
    case "shogi":
      return { game, record: matchDataContracts[game].read(json) };
    case "reversi":
      return { game, record: matchDataContracts[game].readStored(json) };
    case "four-gomoku":
      return { game, record: matchDataContracts[game].readStored(json) };
    case "gomoku":
      return { game, record: matchDataContracts[game].readStored(json) };
    case "four-reversi":
      return { game, record: matchDataContracts[game].readStored(json) };
    case "four-shogi":
      return { game, record: matchDataContracts[game].read(json) };
    default: {
      const exhaustive: never = game;
      throw new Error(`Unsupported match game: ${exhaustive}`);
    }
  }
}
