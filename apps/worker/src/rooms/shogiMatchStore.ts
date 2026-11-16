import {
  readMatchChunk,
  matchChunkSize as chunkSize,
  type ChunkRow,
  type MatchSaveProgress,
} from "@tetraboard/context-record";
import {
  getMatchReplayContract,
  shogiMatchReplayPageSchema,
  fourShogiReplayEventSchema,
  shogiReplayEventSchema,
} from "@tetraboard/protocol";
import type {
  ProfileRatings,
  FourShogiMatchDetail,
  FourShogiReplayEvent,
  FourShogiMatchReplayPage,
  ShogiReplayEvent,
  ShogiMatchReplayPage,
  ShogiMatchDetail,
} from "@tetraboard/protocol";
import type { Side } from "@tetraboard/four-shogi";
import type { FourShogiRatedMatch } from "./fourReversiRating";
import type { ShogiRatingSource } from "./shogiRating";
import type { TournamentRoomContext } from "./tournamentRoom";
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

export { readFourShogiMatchRecord as readShogiMatchRecord } from "../accounts/matchDataContracts";
import { readFourShogiMatchRecord as readShogiMatchRecord } from "../accounts/matchDataContracts";

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
import { shogiMatchData } from "../accounts/shogiMatchData";
type StoredEvent = FourShogiReplayEvent | ShogiReplayEvent;
function eventSchema(game: "four-shogi" | "shogi") {
  return game === "four-shogi" ? fourShogiReplayEventSchema : shogiReplayEventSchema;
}
function readRecord(json: string, game: "four-shogi" | "shogi") {
  return game === "four-shogi" ? readShogiMatchRecord(json) : shogiMatchData.read(json);
}
function readChunk(row: ChunkRow, eventCount: number, game: "four-shogi" | "shogi"): StoredEvent[] {
  return readMatchChunk(row, eventCount, (event) => eventSchema(game).parse(event));
}

export async function readShogiMatchReplayPage(
  db: D1Database,
  matchId: string,
  cursor: number,
  game: "four-shogi" | "shogi" = "four-shogi",
): Promise<
  Omit<FourShogiMatchReplayPage, "matchId"> | Omit<ShogiMatchReplayPage, "matchId"> | null
> {
  const row = await db
    .prepare("SELECT record_json FROM matches WHERE id = ? AND game = ?")
    .bind(matchId, game)
    .first<{ record_json: string }>();
  if (!row) return null;
  const record = readRecord(row.record_json, game);
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > record.replay.eventCount) return null;
  const count = Math.min(chunkSize, record.replay.eventCount - cursor);
  const events: { index: number; event: StoredEvent }[] = [];
  if (count > 0) {
    const first = Math.floor(cursor / chunkSize),
      last = Math.floor((cursor + count - 1) / chunkSize);
    const rows = await db
      .prepare(`SELECT chunk_index, start_index, event_count, events_json
      FROM match_event_chunks WHERE match_id = ? AND chunk_index BETWEEN ? AND ? ORDER BY chunk_index`)
      .bind(matchId, first, last)
      .all<ChunkRow>();
    if (rows.results.length !== last - first + 1)
      throw new Error("Missing stored Shogi replay chunk");
    for (const chunk of rows.results)
      for (const [offset, event] of readChunk(chunk, record.replay.eventCount, game).entries()) {
        const index = chunk.start_index + offset;
        if (index >= cursor && index < cursor + count) events.push({ index, event });
      }
    if (events.length !== count || events.some((event, i) => event.index !== cursor + i))
      throw new Error("Stored Shogi replay is not contiguous");
  }
  return (
    game === "four-shogi" ? getMatchReplayContract.response : shogiMatchReplayPageSchema
  ).parse({
    matchId,
    ...record.replay,
    events,
    nextCursor: cursor + count < record.replay.eventCount ? cursor + count : null,
  });
}
