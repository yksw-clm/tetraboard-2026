import { readMatchReplayPage, type MatchSaveProgress } from "@tetraboard/context-record";
import { D1MatchReadStore } from "../adapters/record/matchReadStore";
import {
  getMatchReplayContract,
  shogiMatchReplayPageSchema,
  fourShogiReplayEventSchema,
  shogiReplayEventSchema,
} from "@tetraboard/protocol";
import type {
  ProfileRatings,
  FourShogiMatchDetail,
  FourShogiMatchReplayPage,
  ShogiMatchReplayPage,
  ShogiMatchDetail,
} from "@tetraboard/protocol";
import type { Side } from "@tetraboard/four-shogi";
import type { FourShogiRatedMatch } from "./fourReversiRating";
import type { ShogiRatingSource } from "./shogiRating";
import type { TournamentRoomContext } from "@tetraboard/context-tournament";
import type { ShogiFormationUsage } from "./shogiFormationUsage";

export type ShogiMatchParticipant = {
  id: string;
  name: string;
  side: Side;
  seat: number;
} & ({ kind: "human"; accountId: string | null; retired?: true } | { kind: "cpu"; level: 1 | 2 });
export type ShogiMatchStart = {
  profileRatings?: ProfileRatings;
  id: string;
  roomId: string;
  instanceId: string;
  startedAtMs: number;
  settings: FourShogiMatchDetail["settings"];
  participants: ShogiMatchParticipant[];
  fourShogiRating?: FourShogiRatedMatch;
};
export type ShogiMatchRecord = ShogiMatchStart & {
  endedAtMs: number;
  game: FourShogiMatchDetail["game"];
  knockouts: Record<Side, number>;
  replay: FourShogiMatchDetail["replay"];
};
export type ShogiSaveProgress = MatchSaveProgress;
export type PendingShogiMatch = {
  record: ShogiMatchRecord;
  tournament?: TournamentRoomContext;
  formationUsage?: ShogiFormationUsage;
  progress: ShogiSaveProgress;
  retryAtMs: number;
};
export type ActiveShogiMatch = {
  start: ShogiMatchStart;
  tournament?: TournamentRoomContext;
  knockouts: Record<Side, number>;
  formationUsage?: ShogiFormationUsage;
};
export const shogiMatchStartKey = "shogi-match-start";
export const pendingShogiMatchPrefix = "shogi-match-pending:";

export function emptyKnockouts(): Record<Side, number> {
  return { south: 0, west: 0, north: 0, east: 0 };
}

export { readFourShogiMatchRecord as readShogiMatchRecord } from "../adapters/record/matchDataContracts";
import { readFourShogiMatchRecord as readShogiMatchRecord } from "../adapters/record/matchDataContracts";

export type StandardShogiMatchRecord = {
  profileRatings?: ProfileRatings;
  id: string;
  roomId: string;
  instanceId: string;
  startedAtMs: number;
  endedAtMs: number;
  settings: ShogiMatchDetail["settings"];
  participants: ({ id: string; name: string; side: "south" | "north"; seat: number } & (
    | { kind: "human"; accountId: string | null; retired?: true }
    | { kind: "cpu"; level: 1 | 2 }
  ))[];
  game: ShogiMatchDetail["game"];
  replay: ShogiMatchDetail["replay"];
  rating?: ShogiRatingSource;
};
export const standardShogiMatchStartKey = "standard-shogi-match-start";
export const pendingStandardShogiMatchPrefix = "standard-shogi-match-pending:";
export type PendingStandardShogiMatch = {
  record: StandardShogiMatchRecord;
  progress: ShogiSaveProgress;
  retryAtMs: number;
};
import { shogiMatchData } from "../adapters/record/shogiMatchData";
function eventSchema(game: "four-shogi" | "shogi") {
  return game === "four-shogi" ? fourShogiReplayEventSchema : shogiReplayEventSchema;
}
function readRecord(json: string, game: "four-shogi" | "shogi") {
  return game === "four-shogi" ? readShogiMatchRecord(json) : shogiMatchData.read(json);
}
export async function readShogiMatchReplayPage(
  db: D1Database,
  matchId: string,
  cursor: number,
  game: "four-shogi" | "shogi" = "four-shogi",
): Promise<
  Omit<FourShogiMatchReplayPage, "matchId"> | Omit<ShogiMatchReplayPage, "matchId"> | null
> {
  const page = await readMatchReplayPage(
    new D1MatchReadStore(db),
    matchId,
    cursor,
    game,
    readRecord,
    (event) => eventSchema(game).parse(event),
  );
  if (!page) return null;
  return (
    game === "four-shogi" ? getMatchReplayContract.response : shogiMatchReplayPageSchema
  ).parse(page);
}
