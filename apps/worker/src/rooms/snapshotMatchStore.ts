import { readStoredMatch, type DecodedMatch } from "../accounts/matchDataContracts";
import { isEventReplay } from "./eventRecord";
import {
  encodeSnapshotMatch,
  rebuildSnapshotMatch,
  readSnapshotMatchEvents,
  matchEventSchema,
  type SnapshotMatch,
} from "./snapshotMatchEvents";
import {
  advanceMatchChunks,
  matchChunkSize,
  publishMatchStatement,
  type MatchSaveProgress,
} from "./matchChunks";
import { ensureMatchUpload } from "./matchUploads";

export async function readMatchDetailRecord(
  db: D1Database,
  json: string,
  game: string,
): Promise<DecodedMatch> {
  const match = readStoredMatch(json, game);
  const events = await readSnapshotMatchEvents(db, match);
  if (!events) return match;
  const restored = readStoredMatch(JSON.stringify(rebuildSnapshotMatch(match, events)), game);
  verifyFinalState(restored);
  return restored;
}
export async function prepareSnapshotMatch(db: D1Database, record: SnapshotMatch) {
  const saved = await db
    .prepare("SELECT game, record_json FROM matches WHERE id = ?")
    .bind(record.id)
    .first<{ game: string; record_json: string }>();
  if (saved) {
    if (saved.game !== record.settings.game) throw new Error("Match ID belongs to another game");
    return { canonical: readStoredMatch(saved.record_json, saved.game), statement: null };
  }
  const encoded = encodeSnapshotMatch(record);
  const json = JSON.stringify(encoded.record);
  const canonical = readStoredMatch(json, record.settings.game);
  const restored = readStoredMatch(
    JSON.stringify(rebuildSnapshotMatch(canonical, encoded.events)),
    record.settings.game,
  );
  verifyFinalState(restored);
  const original = readStoredMatch(JSON.stringify(record), record.settings.game);
  if (JSON.stringify(restored.record) !== JSON.stringify(original.record))
    throw new Error("Match event replay does not match saved steps");
  const schema = matchEventSchema(record.settings.game);
  await ensureMatchUpload(db, encoded.record, Math.ceil(encoded.events.length / matchChunkSize));
  let progress: MatchSaveProgress | null = { phase: "upload", cursor: 0 };
  while (progress)
    progress = await advanceMatchChunks(
      db,
      record.id,
      encoded.events.length,
      progress,
      (cursor) => encoded.events.slice(cursor, cursor + matchChunkSize),
      (event) => schema.parse(event),
    );
  return { canonical, statement: publishMatchStatement(db, record.id) };
}

function verifyFinalState(restored: DecodedMatch) {
  if (restored.game !== "shogi" && restored.game !== "four-shogi") {
    const replay = restored.record.replay;
    if (isEventReplay(replay)) throw new Error("Match replay was not restored");
    if (
      JSON.stringify(replay.steps.at(-1)?.game ?? replay.initial) !==
      JSON.stringify(restored.record.game)
    )
      throw new Error("Match replay final state mismatch");
  }
}
