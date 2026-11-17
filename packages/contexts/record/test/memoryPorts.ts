import type { ChunkRow, MatchRecordStore, SavedMatch, UploadRecord } from "../src";

export type Publication = { matchId: string };

export class MemoryRecordStore implements MatchRecordStore<Publication> {
  saved = new Map<string, SavedMatch>();
  uploads = new Map<string, { json: string; count: number; chunks: number }>();
  chunks = new Map<string, Map<number, ChunkRow>>();
  failChunk: number | null = null;
  failPublication = false;

  async readSaved(id: string) {
    return this.saved.get(id) ?? null;
  }
  async insertUpload(record: UploadRecord, json: string, chunkCount: number) {
    if (!this.uploads.has(record.id))
      this.uploads.set(record.id, { json, count: record.replay.eventCount, chunks: chunkCount });
  }
  async readUpload(id: string) {
    return this.uploads.get(id)?.json ?? null;
  }
  async replaceUpload(id: string, previous: string, json: string) {
    const upload = this.uploads.get(id);
    if (!upload || upload.json !== previous) return null;
    upload.json = json;
    return json;
  }
  async insertChunk(id: string, row: ChunkRow) {
    if (row.chunk_index === this.failChunk) throw new Error("Chunk unavailable");
    let chunks = this.chunks.get(id);
    if (!chunks) this.chunks.set(id, (chunks = new Map()));
    if (!chunks.has(row.chunk_index)) chunks.set(row.chunk_index, structuredClone(row));
  }
  async readChunks(id: string, start: number, end: number) {
    return [...(this.chunks.get(id)?.values() ?? [])]
      .filter((row) => row.chunk_index >= start && row.chunk_index < end)
      .sort((a, b) => a.chunk_index - b.chunk_index);
  }
  publication(matchId: string): Publication {
    return { matchId };
  }
  commit({ matchId }: Publication) {
    if (this.failPublication) throw new Error("Publication unavailable");
    const upload = this.uploads.get(matchId);
    if (!upload) throw new Error("Missing upload");
    const chunks = [...(this.chunks.get(matchId)?.values() ?? [])];
    if (
      chunks.length !== upload.chunks ||
      chunks.reduce((sum, row) => sum + row.event_count, 0) !== upload.count
    )
      throw new Error("Incomplete upload");
    if (!this.saved.has(matchId)) {
      const record = JSON.parse(upload.json) as UploadRecord;
      this.saved.set(matchId, { game: record.settings.game, recordJson: upload.json });
    }
  }
}

export const normalize = async (json: string) => json;
export const parse = (event: unknown): number => {
  if (typeof event !== "number") throw new Error("Invalid event");
  return event;
};
export const events = Array.from({ length: 501 }, (_, i) => i);
export const source = (cursor: number) => events.slice(cursor, cursor + 100);
export const record = {
  id: "match",
  settings: { game: "shogi" },
  replay: { eventCount: events.length },
  endedAtMs: 100,
};
