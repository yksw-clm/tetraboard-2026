import { matchChunkSize, readMatchChunk } from "../domain/matchChunks";
import type { MatchReadStore } from "./readPorts";

type ReplayRecord = { replay: { eventCount: number; initial: unknown; rulesVersion: number } };
export async function readMatchReplayPage<R extends ReplayRecord, E>(
  store: MatchReadStore,
  matchId: string,
  cursor: number,
  game: "shogi" | "four-shogi",
  readRecord: (json: string, game: "shogi" | "four-shogi") => R,
  parse: (event: unknown) => E,
) {
  const json = await store.readReplayRecord(matchId, game);
  if (json === null) return null;
  const record = readRecord(json, game);
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > record.replay.eventCount) return null;
  const count = Math.min(matchChunkSize, record.replay.eventCount - cursor);
  const events: { index: number; event: E }[] = [];
  if (count > 0) {
    const first = Math.floor(cursor / matchChunkSize),
      last = Math.floor((cursor + count - 1) / matchChunkSize);
    const rows = await store.readReplayChunks(matchId, first, last);
    if (rows.length !== last - first + 1) throw new Error("Missing stored Shogi replay chunk");
    for (const chunk of rows)
      for (const [offset, event] of readMatchChunk(
        chunk,
        record.replay.eventCount,
        parse,
      ).entries()) {
        const index = chunk.start_index + offset;
        if (index >= cursor && index < cursor + count) events.push({ index, event });
      }
    if (events.length !== count || events.some((event, i) => event.index !== cursor + i))
      throw new Error("Stored Shogi replay is not contiguous");
  }
  return {
    matchId,
    ...record.replay,
    events,
    nextCursor: cursor + count < record.replay.eventCount ? cursor + count : null,
  };
}
