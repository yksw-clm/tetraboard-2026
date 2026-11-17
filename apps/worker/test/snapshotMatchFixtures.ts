import { readMatchRecord } from "../src/accounts/matchDataContracts";
import { encodeSnapshotMatch } from "../src/rooms/snapshotMatchEvents";
import { matchChunkSize } from "@tetraboard/context-record";

// 集計用の任意順位も、D1の本体・チャンクの現行形式で用意します。
export async function prepareStoredMatchFixture(db: D1Database, json: string) {
  const match = readMatchRecord(json, JSON.parse(json).settings.game);
  if (match.game === "shogi" || match.game === "four-shogi") return json;
  const encoded = encodeSnapshotMatch(match.record);
  for (let cursor = 0; cursor < encoded.events.length; cursor += matchChunkSize) {
    const events = encoded.events.slice(cursor, cursor + matchChunkSize);
    await db
      .prepare(
        "INSERT INTO match_event_chunks VALUES (?, ?, ?, ?, ?) ON CONFLICT(match_id, chunk_index) DO NOTHING",
      )
      .bind(match.record.id, cursor / matchChunkSize, cursor, events.length, JSON.stringify(events))
      .run();
  }
  return JSON.stringify(encoded.record);
}
