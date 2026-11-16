import { matchChunkSize, readMatchChunk, createMatchChunk } from "../domain/matchChunks";
import type { MatchRecordStore, MatchSaveProgress } from "./ports";

export async function advanceMatchChunks<E>(
  store: MatchRecordStore<unknown>,
  matchId: string,
  eventCount: number,
  progress: MatchSaveProgress,
  readEvents: (cursor: number) => E[],
  parse: (event: unknown) => E,
): Promise<MatchSaveProgress | null> {
  const chunkCount = Math.ceil(eventCount / matchChunkSize);
  if (!Number.isInteger(progress.cursor) || progress.cursor < 0 || progress.cursor > chunkCount)
    throw new Error("Invalid match save progress");
  const end = Math.min(progress.cursor + 4, chunkCount);
  if (progress.phase === "upload") {
    for (let index = progress.cursor; index < end; index++) {
      const events = readEvents(index * matchChunkSize);
      const row = createMatchChunk(index, eventCount, events, parse);
      await store.insertChunk(matchId, row);
    }
    return end === chunkCount ? { phase: "verify", cursor: 0 } : { phase: "upload", cursor: end };
  }
  if (progress.phase !== "verify") throw new Error("Invalid match save phase");
  const rows = await store.readChunks(matchId, progress.cursor, end);
  if (rows.length !== end - progress.cursor) throw new Error("Missing match replay chunk");
  for (const [offset, row] of rows.entries()) {
    if (row.chunk_index !== progress.cursor + offset) throw new Error("Match chunk index mismatch");
    const stored = readMatchChunk(row, eventCount, parse);
    const expected = readEvents(row.start_index).map(parse);
    if (JSON.stringify(stored) !== JSON.stringify(expected))
      throw new Error("Match chunk content mismatch");
  }
  return end < chunkCount ? { phase: "verify", cursor: end } : null;
}
