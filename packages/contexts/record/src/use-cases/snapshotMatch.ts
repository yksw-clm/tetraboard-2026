import { matchChunkSize } from "../domain/matchChunks";
import { advanceMatchChunks } from "./matchChunks";
import { ensureMatchUpload } from "./matchUploads";
import type { MatchRecordStore, MatchSaveProgress, NormalizeUpload, UploadRecord } from "./ports";

export type SnapshotSaveValidation<Record, Canonical, Event> = {
  readStored(json: string, game: string): Canonical;
  encode(record: Record): { record: UploadRecord; canonical: Canonical; events: Event[] };
  parse(event: unknown): Event;
  normalize: NormalizeUpload;
};

export async function prepareSnapshotMatch<
  Record extends { id: string; settings: { game: string } },
  Canonical,
  Event,
  Write,
>(
  store: MatchRecordStore<Write>,
  record: Record,
  validation: SnapshotSaveValidation<Record, Canonical, Event>,
): Promise<{ canonical: Canonical; statement: Write | null }> {
  const saved = await store.readSaved(record.id);
  if (saved) {
    if (saved.game !== record.settings.game) throw new Error("Match ID belongs to another game");
    return { canonical: validation.readStored(saved.recordJson, saved.game), statement: null };
  }
  const encoded = validation.encode(record);
  await ensureMatchUpload(
    store,
    encoded.record,
    Math.ceil(encoded.events.length / matchChunkSize),
    validation.normalize,
  );
  let progress: MatchSaveProgress | null = { phase: "upload", cursor: 0 };
  while (progress)
    progress = await advanceMatchChunks(
      store,
      record.id,
      encoded.events.length,
      progress,
      (cursor) => encoded.events.slice(cursor, cursor + matchChunkSize),
      validation.parse,
    );
  return { canonical: encoded.canonical, statement: store.publication(record.id) };
}
