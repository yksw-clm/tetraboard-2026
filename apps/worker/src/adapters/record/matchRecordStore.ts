import type { ChunkRow, MatchRecordStore, UploadRecord } from "@tetraboard/context-record";
import { mergedRecordJsonSql } from "./guestMerges";
import { scrubbedRecordJsonSql } from "./privacyScrub";

export class D1MatchRecordStore implements MatchRecordStore<D1PreparedStatement> {
  constructor(private readonly db: D1Database) {}
  async readSaved(matchId: string) {
    const row = await this.db
      .prepare("SELECT game, record_json FROM matches WHERE id = ?")
      .bind(matchId)
      .first<{ game: string; record_json: string }>();
    return row ? { game: row.game, recordJson: row.record_json } : null;
  }
  async insertUpload(record: UploadRecord, json: string, chunkCount: number) {
    await this.db
      .prepare(`INSERT INTO match_uploads
    SELECT ?1, ${scrubbedRecordJsonSql(mergedRecordJsonSql("input.record_json"), "?1")}, ?, ?
    FROM (SELECT ? AS record_json) input
    WHERE true
    ON CONFLICT(id) DO NOTHING`)
      .bind(record.id, record.replay.eventCount, chunkCount, json)
      .run();
  }
  async readUpload(matchId: string) {
    const row = await this.db
      .prepare("SELECT record_json FROM match_uploads WHERE id = ?")
      .bind(matchId)
      .first<{ record_json: string }>();
    return row?.record_json ?? null;
  }
  async replaceUpload(matchId: string, previous: string, json: string) {
    const row = await this.db
      .prepare(`UPDATE match_uploads SET record_json=${scrubbedRecordJsonSql("?1", "match_uploads.id")}
      WHERE id=? AND record_json=? RETURNING id`)
      .bind(json, matchId, previous)
      .first<{ id: string }>();
    // 呼び出し元との照合には、伏せ字を適用する前の更新入力を返します。
    return row ? json : null;
  }
  async insertChunk(matchId: string, row: ChunkRow) {
    await this.db
      .prepare(`INSERT INTO match_event_chunks VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(match_id, chunk_index) DO NOTHING`)
      .bind(matchId, row.chunk_index, row.start_index, row.event_count, row.events_json)
      .run();
  }
  async readChunks(matchId: string, start: number, end: number) {
    const rows = await this.db
      .prepare(`SELECT chunk_index, start_index, event_count, events_json
    FROM match_event_chunks WHERE match_id = ? AND chunk_index >= ? AND chunk_index < ?
    ORDER BY chunk_index`)
      .bind(matchId, start, end)
      .all<ChunkRow>();
    return rows.results;
  }
  publication(matchId: string) {
    return publishMatchStatement(this.db, matchId);
  }
}

export function publishMatchStatement(db: D1Database, matchId: string) {
  return db
    .prepare(`INSERT INTO matches (id, game, mode, started_at_ms, ended_at_ms, record_json)
    SELECT id, json_extract(record_json, '$.settings.game'), COALESCE(json_extract(record_json, '$.settings.mode'), 'standard'),
      json_extract(record_json, '$.startedAtMs'), json_extract(record_json, '$.endedAtMs'),
      ${scrubbedRecordJsonSql(mergedRecordJsonSql("u.record_json"), "u.id")}
    FROM match_uploads u WHERE id = ?
      AND (SELECT COUNT(*) FROM match_event_chunks WHERE match_id = u.id) = u.chunk_count
      AND COALESCE((SELECT SUM(event_count) FROM match_event_chunks WHERE match_id = u.id), 0) = u.event_count
    ON CONFLICT(id) DO NOTHING`)
    .bind(matchId);
}
