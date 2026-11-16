export type MatchSaveProgress = { phase: "upload" | "verify"; cursor: number };
export const matchChunkSize = 100;
export type ChunkRow = {
  chunk_index: number;
  start_index: number;
  event_count: number;
  events_json: string;
};
export function readMatchChunk<E>(
  row: ChunkRow,
  eventCount: number,
  parse: (event: unknown) => E,
): E[] {
  const events: unknown = JSON.parse(row.events_json);
  const expected = Math.min(matchChunkSize, eventCount - row.chunk_index * matchChunkSize);
  if (
    !Number.isInteger(row.chunk_index) ||
    row.chunk_index < 0 ||
    row.start_index !== row.chunk_index * matchChunkSize ||
    expected <= 0 ||
    row.event_count !== expected ||
    !Array.isArray(events) ||
    events.length !== expected
  )
    throw new Error("Match replay chunk is incomplete");
  return events.map(parse);
}
export async function advanceMatchChunks<E>(
  db: D1Database,
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
      const row: ChunkRow = {
        chunk_index: index,
        start_index: index * matchChunkSize,
        event_count: events.length,
        events_json: JSON.stringify(events),
      };
      readMatchChunk(row, eventCount, parse);
      await db
        .prepare(`INSERT INTO match_event_chunks VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(match_id, chunk_index) DO NOTHING`)
        .bind(matchId, index, row.start_index, row.event_count, row.events_json)
        .run();
    }
    return end === chunkCount ? { phase: "verify", cursor: 0 } : { phase: "upload", cursor: end };
  }
  if (progress.phase !== "verify") throw new Error("Invalid match save phase");
  const rows = await db
    .prepare(`SELECT chunk_index, start_index, event_count, events_json
    FROM match_event_chunks WHERE match_id = ? AND chunk_index >= ? AND chunk_index < ?
    ORDER BY chunk_index`)
    .bind(matchId, progress.cursor, end)
    .all<ChunkRow>();
  if (rows.results.length !== end - progress.cursor) throw new Error("Missing match replay chunk");
  for (const [offset, row] of rows.results.entries()) {
    if (row.chunk_index !== progress.cursor + offset) throw new Error("Match chunk index mismatch");
    const stored = readMatchChunk(row, eventCount, parse);
    const expected = readEvents(row.start_index).map(parse);
    if (JSON.stringify(stored) !== JSON.stringify(expected))
      throw new Error("Match chunk content mismatch");
  }
  return end < chunkCount ? { phase: "verify", cursor: end } : null;
}
export function publishMatchStatement(db: D1Database, matchId: string) {
  return db
    .prepare(`INSERT INTO matches (id, game, mode, started_at_ms, ended_at_ms, record_json)
    SELECT id, json_extract(record_json, '$.settings.game'), COALESCE(json_extract(record_json, '$.settings.mode'), 'standard'),
      json_extract(record_json, '$.startedAtMs'), json_extract(record_json, '$.endedAtMs'), record_json
    FROM match_uploads u WHERE id = ?
      AND (SELECT COUNT(*) FROM match_event_chunks WHERE match_id = u.id) = u.chunk_count
      AND COALESCE((SELECT SUM(event_count) FROM match_event_chunks WHERE match_id = u.id), 0) = u.event_count
    ON CONFLICT(id) DO NOTHING`)
    .bind(matchId);
}
