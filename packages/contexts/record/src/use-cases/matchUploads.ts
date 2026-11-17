import type { MatchRecordStore, NormalizeUpload, UploadRecord } from "./ports";

export async function ensureMatchUpload<Record extends UploadRecord>(
  store: MatchRecordStore<unknown>,
  record: Record,
  chunkCount: number,
  normalize: NormalizeUpload,
  conflictMessage = "Conflicting match upload",
) {
  const canonical = await normalize(JSON.stringify(record));
  await store.insertUpload(record, canonical, chunkCount);
  const upload = await store.readUpload(record.id);
  if (upload === null) throw new Error("Missing match upload");
  const json = await normalize(upload);
  if (json !== canonical) throw new Error(conflictMessage);
  if (json !== upload) {
    const updated = await store.replaceUpload(record.id, upload, json);
    if (updated !== canonical) throw new Error(conflictMessage);
  }
}
