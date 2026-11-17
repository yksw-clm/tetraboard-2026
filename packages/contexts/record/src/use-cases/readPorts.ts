import type { GameId, MatchHistoryFilter, MatchKind, RoomMode } from "@tetraboard/protocol";
import type { ChunkRow } from "../domain/matchChunks";

export type MatchRow = { game: string; record_json: string };
export type HistoryQuery = {
  accountId: string;
  game: GameId;
  mode?: RoomMode;
  cursor: { startedAtMs: number; id: string } | null;
  filter: MatchHistoryFilter;
};
export interface MatchReadStore {
  readMatch(matchId: string, accountId?: string): Promise<MatchRow | null>;
  readHistory(query: HistoryQuery): Promise<MatchRow[]>;
  readPublic(game: GameId | undefined, humanOnly: boolean): Promise<MatchRow[]>;
  readKinds(matchIds: string[]): Promise<ReadonlyMap<string, MatchKind>>;
  readDetailChunks(matchId: string): Promise<ChunkRow[]>;
  readReplayRecord(matchId: string, game: "shogi" | "four-shogi"): Promise<string | null>;
  readReplayChunks(matchId: string, first: number, last: number): Promise<ChunkRow[]>;
}
