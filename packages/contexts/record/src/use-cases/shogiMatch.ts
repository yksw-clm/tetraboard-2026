import { matchChunkSize } from "../domain/matchChunks";
import { advanceMatchChunks } from "./matchChunks";
import { ensureMatchUpload } from "./matchUploads";
import type {
  MatchRecordStore,
  MatchSaveProgress,
  NormalizeUpload,
  SavedMatch,
  UploadRecord,
} from "./ports";

export type EventMatchSave<Write> =
  | { status: "saved"; saved: SavedMatch }
  | { status: "progress"; progress: MatchSaveProgress }
  | { status: "publish"; statement: Write };

/** 再送時も、1回の処理で転送・検証するイベントを最大400件に制限します。 */
export async function advanceShogiMatchSave<Event, Write, Record extends UploadRecord>(
  store: MatchRecordStore<Write>,
  record: Record,
  progress: MatchSaveProgress,
  readEvents: (cursor: number) => Event[],
  parse: (event: unknown) => Event,
  normalize: NormalizeUpload,
): Promise<EventMatchSave<Write>> {
  const saved = await store.readSaved(record.id);
  if (saved) {
    if (saved.game !== record.settings.game) throw new Error("Match ID belongs to another game");
    return { status: "saved", saved };
  }
  await ensureMatchUpload(
    store,
    record,
    Math.ceil(record.replay.eventCount / matchChunkSize),
    normalize,
    "Conflicting Shogi match upload",
  );
  const next = await advanceMatchChunks(
    store,
    record.id,
    record.replay.eventCount,
    progress,
    readEvents,
    parse,
  );
  return next
    ? { status: "progress", progress: next }
    : { status: "publish", statement: store.publication(record.id) };
}
