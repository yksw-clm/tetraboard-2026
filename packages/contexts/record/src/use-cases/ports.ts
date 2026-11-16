import type { ChunkRow } from "../domain/matchChunks";

export type MatchSaveProgress = { phase: "upload" | "verify"; cursor: number };
export type SavedMatch = { game: string; recordJson: string };
export type UploadRecord = {
  id: string;
  settings: { game: string };
  replay: { eventCount: number };
};

// 公開の書き込みは実行せず、殻がほかの文脈の書き込みと同じ batch に並べます。
export interface MatchRecordStore<Write> {
  readSaved(matchId: string): Promise<SavedMatch | null>;
  insertUpload(record: UploadRecord, json: string, chunkCount: number): Promise<void>;
  readUpload(matchId: string): Promise<string | null>;
  replaceUpload(matchId: string, previous: string, json: string): Promise<string | null>;
  insertChunk(matchId: string, row: ChunkRow): Promise<void>;
  readChunks(matchId: string, start: number, end: number): Promise<ChunkRow[]>;
  publication(matchId: string): Write;
}

export type NormalizeUpload = (json: string) => Promise<string>;
