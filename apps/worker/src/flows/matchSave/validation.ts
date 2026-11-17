import { redactParticipants } from "../../privacy/identity";
import { readStoredMatch, readMatchRecord } from "../../accounts/matchDataContracts";
import {
  encodeSnapshotMatch,
  rebuildSnapshotMatch,
  type SnapshotMatch,
} from "../../rooms/snapshotMatchEvents";
import { verifyFinalState, verifySnapshotReplay } from "@tetraboard/context-record";

type UploadRecord = {
  id: string;
  settings: { game: string };
  replay: { eventCount: number };
  participants: { id?: string; kind: string; name: string; accountId?: string | null }[];
  profileRatings?: Record<string, unknown>;
};

export function normalizeMatchUpload(db: D1Database, game: string) {
  return async (json: string) => {
    readStoredMatch(json, game);
    const record = await redactParticipants(db, JSON.parse(json) as UploadRecord);
    const canonical = JSON.stringify(record);
    readStoredMatch(canonical, game);
    return canonical;
  };
}

export function encodeValidatedSnapshot(record: SnapshotMatch) {
  const encoded = encodeSnapshotMatch(record);
  const canonical = readStoredMatch(JSON.stringify(encoded.record), record.settings.game);
  const restored = readMatchRecord(
    JSON.stringify(rebuildSnapshotMatch(canonical, encoded.events)),
    record.settings.game,
  );
  if (restored.game !== "shogi" && restored.game !== "four-shogi")
    verifyFinalState(restored.record);
  const original = readMatchRecord(JSON.stringify(record), record.settings.game);
  verifySnapshotReplay(restored.record, original.record);
  return { ...encoded, canonical };
}
