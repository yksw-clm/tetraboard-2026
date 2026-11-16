import { redactParticipants } from "../privacy/identity";
import { readStoredMatch } from "../accounts/matchDataContracts";
import { normalizeLegacyShogiState } from "./normalizeLegacyShogiState";

type UploadRecord = {
  id: string;
  settings: { game: string };
  replay: { eventCount: number };
  participants: { id?: string; kind: string; name: string; accountId?: string | null }[];
  profileRatings?: Record<string, unknown>;
};

export async function ensureMatchUpload(
  db: D1Database,
  record: UploadRecord,
  chunkCount: number,
  conflictMessage = "Conflicting match upload",
) {
  record = await redactUpload(db, record);
  const canonical = JSON.stringify(record);
  const read = (json: string) => readStoredMatch(json, record.settings.game);
  read(canonical);
  await db
    .prepare(`INSERT INTO match_uploads VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING`)
    .bind(record.id, canonical, record.replay.eventCount, chunkCount)
    .run();
  const upload = await db
    .prepare("SELECT record_json FROM match_uploads WHERE id = ?")
    .bind(record.id)
    .first<{ record_json: string }>();
  if (!upload) throw new Error("Missing match upload");
  const stored: UploadRecord = JSON.parse(upload.record_json);
  const json = JSON.stringify(await redactUpload(db, stored));
  if (json !== canonical) throw new Error(conflictMessage);
  if (json !== upload.record_json) {
    const updated = await db
      .prepare(`UPDATE match_uploads SET record_json=?
      WHERE id=? AND record_json=? RETURNING record_json`)
      .bind(json, record.id, upload.record_json)
      .first<{ record_json: string }>();
    if (updated?.record_json !== canonical) throw new Error(conflictMessage);
  }
}

async function redactUpload(db: D1Database, record: UploadRecord): Promise<UploadRecord> {
  const restored = normalizeLegacyShogiState(record) as UploadRecord;
  readStoredMatch(JSON.stringify(restored), restored.settings.game);
  return redactParticipants(db, restored);
}
