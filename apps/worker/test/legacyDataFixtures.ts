import { matchChunkSize } from "@tetraboard/context-record";

export async function seedLegacyShogiUpload(db: D1Database, source: string) {
  // 旧棋譜を、引分提案だけが補完された保存待ちの形で入れます。
  const record = JSON.parse(source) as {
    id: string;
    game: { drawProposals?: unknown[] };
    replay: { eventCount: number };
  };
  record.game.drawProposals ??= [];
  const json = JSON.stringify(record);
  await db
    .prepare(
      "INSERT INTO match_uploads (id, record_json, event_count, chunk_count) VALUES (?,?,?,?)",
    )
    .bind(
      record.id,
      json,
      record.replay.eventCount,
      Math.ceil(record.replay.eventCount / matchChunkSize),
    )
    .run();
  return json;
}
