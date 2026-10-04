import {
  fourShogiReplayEventSchema,
  type FourShogiMatchDetail,
  type FourShogiReplayEvent,
  type MatchReplayPage,
} from "@tetraboard/protocol";
import { type Side } from "@tetraboard/four-shogi";

export type ShogiMatchParticipant = {
  id: string;
  name: string;
  side: Side;
  seat: number;
} & ({ kind: "human"; accountId: string | null } | { kind: "cpu"; level: 1 | 2 });
export type ShogiMatchStart = {
  id: string;
  roomId: string;
  instanceId: string;
  startedAtMs: number;
  settings: FourShogiMatchDetail["settings"];
  participants: ShogiMatchParticipant[];
};
export type ShogiMatchRecord = ShogiMatchStart & {
  endedAtMs: number;
  game: FourShogiMatchDetail["game"];
  knockouts: Record<Side, number>;
  replay: FourShogiMatchDetail["replay"];
};
export type ShogiSaveProgress = { phase: "upload" | "verify"; cursor: number };
export type PendingShogiMatch = {
  record: ShogiMatchRecord;
  progress: ShogiSaveProgress;
  retryAtMs: number;
};
export type ActiveShogiMatch = { start: ShogiMatchStart; knockouts: Record<Side, number> };
export const shogiMatchStartKey = "shogi-match-start";
export const pendingShogiMatchPrefix = "shogi-match-pending:";
const chunkSize = 100;
const chunksPerPass = 4;

export function emptyKnockouts(): Record<Side, number> {
  return { south: 0, west: 0, north: 0, east: 0 };
}

// 読取り用の正規化結果は保存manifestの照合文字列に使用しません。
export { readFourShogiMatchRecord as readShogiMatchRecord } from "../accounts/matchDataContracts";
import { readFourShogiMatchRecord as readShogiMatchRecord } from "../accounts/matchDataContracts";

type ChunkRow = {
  chunk_index: number;
  start_index: number;
  event_count: number;
  events_json: string;
};
function readChunk(row: ChunkRow, eventCount: number): FourShogiReplayEvent[] {
  const events = JSON.parse(row.events_json) as unknown;
  const expected = Math.min(chunkSize, eventCount - row.chunk_index * chunkSize);
  if (
    !Number.isInteger(row.chunk_index) ||
    row.chunk_index < 0 ||
    row.start_index !== row.chunk_index * chunkSize ||
    expected <= 0 ||
    row.event_count !== expected ||
    !Array.isArray(events) ||
    events.length !== expected
  )
    throw new Error("Shogi replay chunk is incomplete");
  return events.map((event) => fourShogiReplayEventSchema.parse(event));
}

/** 再送時も、1回の処理で転送・検証するイベントを最大400件に制限します。 */
export async function advanceShogiMatchSave(
  db: D1Database,
  record: ShogiMatchRecord,
  progress: ShogiSaveProgress,
  readEvents: (cursor: number) => FourShogiReplayEvent[],
): Promise<ShogiSaveProgress | null> {
  const existing = await db
    .prepare("SELECT game FROM matches WHERE id = ?")
    .bind(record.id)
    .first<{ game: string }>();
  if (existing) {
    if (existing.game !== "four-shogi") throw new Error("Match ID belongs to another game");
    await db.prepare("DELETE FROM shogi_match_uploads WHERE id = ?").bind(record.id).run();
    return null;
  }
  const canonical = JSON.stringify(record);
  readShogiMatchRecord(canonical);
  const chunkCount = Math.ceil(record.replay.eventCount / chunkSize);
  await db
    .prepare(`INSERT INTO shogi_match_uploads VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING`)
    .bind(record.id, canonical, record.replay.eventCount, chunkCount)
    .run();
  const upload = await db
    .prepare("SELECT record_json FROM shogi_match_uploads WHERE id = ?")
    .bind(record.id)
    .first<{ record_json: string }>();
  if (upload?.record_json !== canonical) throw new Error("Conflicting Shogi match upload");
  if (!Number.isInteger(progress.cursor) || progress.cursor < 0 || progress.cursor > chunkCount)
    throw new Error("Invalid Shogi save progress");
  const end = Math.min(progress.cursor + chunksPerPass, chunkCount);
  if (progress.phase === "upload") {
    for (let index = progress.cursor; index < end; index++) {
      const events = readEvents(index * chunkSize);
      const row: ChunkRow = {
        chunk_index: index,
        start_index: index * chunkSize,
        event_count: events.length,
        events_json: JSON.stringify(events),
      };
      readChunk(row, record.replay.eventCount);
      await db
        .prepare(`INSERT INTO shogi_match_chunks VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(match_id, chunk_index) DO NOTHING`)
        .bind(record.id, index, row.start_index, row.event_count, row.events_json)
        .run();
    }
    return end === chunkCount ? { phase: "verify", cursor: 0 } : { phase: "upload", cursor: end };
  }
  const rows = await db
    .prepare(`SELECT chunk_index, start_index, event_count, events_json
    FROM shogi_match_chunks WHERE match_id = ? AND chunk_index >= ? AND chunk_index < ?
    ORDER BY chunk_index`)
    .bind(record.id, progress.cursor, end)
    .all<ChunkRow>();
  if (rows.results.length !== end - progress.cursor) throw new Error("Missing Shogi replay chunk");
  for (const [offset, row] of rows.results.entries()) {
    if (row.chunk_index !== progress.cursor + offset) throw new Error("Shogi chunk index mismatch");
    const stored = readChunk(row, record.replay.eventCount);
    const expected = readEvents(row.start_index).map((event) =>
      fourShogiReplayEventSchema.parse(event),
    );
    if (JSON.stringify(stored) !== JSON.stringify(expected))
      throw new Error("Shogi chunk content mismatch");
  }
  if (end < chunkCount) return { phase: "verify", cursor: end };
  // 不変の棋譜行をすべて検証した後、本体と全アカウント索引を一緒に確定します。
  await db.batch([
    db
      .prepare(`INSERT INTO matches (id, game, mode, started_at_ms, ended_at_ms, record_json)
      SELECT id, 'four-shogi', json_extract(record_json, '$.settings.mode'),
        json_extract(record_json, '$.startedAtMs'), json_extract(record_json, '$.endedAtMs'), record_json
      FROM shogi_match_uploads u WHERE id = ?
        AND (SELECT COUNT(*) FROM shogi_match_chunks WHERE match_id = u.id) = u.chunk_count
        AND COALESCE((SELECT SUM(event_count) FROM shogi_match_chunks WHERE match_id = u.id), 0) = u.event_count
      ON CONFLICT(id) DO NOTHING`)
      .bind(record.id),
    db
      .prepare(`INSERT INTO account_match_history (account_id, match_id, mode, started_at_ms, game)
      SELECT json_extract(p.value, '$.accountId'), m.id, m.mode, m.started_at_ms, m.game
      FROM matches m, json_each(m.record_json, '$.participants') p
      WHERE m.id = ? AND m.game = 'four-shogi' AND json_extract(p.value, '$.kind') = 'human'
        AND json_extract(p.value, '$.accountId') IS NOT NULL
      ON CONFLICT(account_id, match_id) DO NOTHING`)
      .bind(record.id),
  ]);
  if (!(await db.prepare("SELECT id FROM matches WHERE id = ?").bind(record.id).first()))
    throw new Error("Shogi match publication was incomplete");
  await db.prepare("DELETE FROM shogi_match_uploads WHERE id = ?").bind(record.id).run();
  return null;
}

export async function readShogiMatchReplayPage(
  db: D1Database,
  matchId: string,
  cursor: number,
): Promise<Omit<MatchReplayPage, "matchId"> | null> {
  const row = await db
    .prepare("SELECT record_json FROM matches WHERE id = ? AND game = 'four-shogi'")
    .bind(matchId)
    .first<{ record_json: string }>();
  if (!row) return null;
  const record = readShogiMatchRecord(row.record_json);
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > record.replay.eventCount) return null;
  const count = Math.min(chunkSize, record.replay.eventCount - cursor);
  const events: MatchReplayPage["events"] = [];
  if (count > 0) {
    const first = Math.floor(cursor / chunkSize),
      last = Math.floor((cursor + count - 1) / chunkSize);
    const rows = await db
      .prepare(`SELECT chunk_index, start_index, event_count, events_json
      FROM shogi_match_chunks WHERE match_id = ? AND chunk_index BETWEEN ? AND ? ORDER BY chunk_index`)
      .bind(matchId, first, last)
      .all<ChunkRow>();
    if (rows.results.length !== last - first + 1)
      throw new Error("Missing stored Shogi replay chunk");
    for (const chunk of rows.results)
      for (const [offset, event] of readChunk(chunk, record.replay.eventCount).entries()) {
        const index = chunk.start_index + offset;
        if (index >= cursor && index < cursor + count) events.push({ index, event });
      }
    if (events.length !== count || events.some((event, i) => event.index !== cursor + i))
      throw new Error("Stored Shogi replay is not contiguous");
  }
  return {
    ...record.replay,
    events,
    nextCursor: cursor + count < record.replay.eventCount ? cursor + count : null,
  };
}
