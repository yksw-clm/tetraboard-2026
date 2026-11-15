import { readFourShogiMatchRecord } from "../accounts/matchDataContracts";
import { shogiMatchData } from "../accounts/shogiMatchData";
import type { ShogiMatchRecord, StandardShogiMatchRecord } from "./shogiMatchStore";
import { normalizeLegacyShogiState } from "./normalizeLegacyShogiState";

export async function ensureShogiMatchUpload(
  db: D1Database,
  record: ShogiMatchRecord | StandardShogiMatchRecord,
  chunkCount: number,
) {
  const canonical = JSON.stringify(record);
  const read =
    record.settings.game === "four-shogi" ? readFourShogiMatchRecord : shogiMatchData.read;
  read(canonical);
  await db
    .prepare(`INSERT INTO shogi_match_uploads VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING`)
    .bind(record.id, canonical, record.replay.eventCount, chunkCount)
    .run();
  const upload = await db
    .prepare("SELECT record_json FROM shogi_match_uploads WHERE id = ?")
    .bind(record.id)
    .first<{ record_json: string }>();
  if (!upload) throw new Error("Missing Shogi match upload");
  const stored: unknown = JSON.parse(upload.record_json);
  const restored = normalizeLegacyShogiState(stored);
  const json = restored === stored ? upload.record_json : JSON.stringify(restored);
  read(json);
  if (json !== canonical) throw new Error("Conflicting Shogi match upload");
  if (json !== upload.record_json) {
    const updated = await db
      .prepare(`UPDATE shogi_match_uploads SET record_json=?
      WHERE id=? AND record_json=? RETURNING record_json`)
      .bind(json, record.id, upload.record_json)
      .first<{ record_json: string }>();
    if (updated?.record_json !== canonical) throw new Error("Conflicting Shogi match upload");
  }
}
