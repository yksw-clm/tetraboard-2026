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

export function readMatchChunks<E>(
  rows: ChunkRow[],
  count: number,
  parse: (event: unknown) => E,
): E[] {
  if (rows.length !== Math.ceil(count / matchChunkSize))
    throw new Error("Missing match replay chunk");
  return rows.flatMap((row, index) => {
    if (row.chunk_index !== index) throw new Error("Match replay is not contiguous");
    return readMatchChunk(row, count, parse);
  });
}

export function createMatchChunk<E>(
  index: number,
  eventCount: number,
  events: E[],
  parse: (event: unknown) => E,
): ChunkRow {
  const row = {
    chunk_index: index,
    start_index: index * matchChunkSize,
    event_count: events.length,
    events_json: JSON.stringify(events),
  };
  readMatchChunk(row, eventCount, parse);
  return row;
}
