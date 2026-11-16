import { verifyFinalState } from "@tetraboard/context-record";
import {
  readStoredMatch,
  readMatchRecord,
  type ReplayedMatch,
} from "../accounts/matchDataContracts";
import { rebuildSnapshotMatch, readSnapshotMatchEvents } from "./snapshotMatchEvents";

export async function readMatchDetailRecord(
  db: D1Database,
  json: string,
  game: string,
): Promise<ReplayedMatch> {
  const match = readStoredMatch(json, game);
  const events = await readSnapshotMatchEvents(db, match);
  if (match.game === "shogi" || match.game === "four-shogi") return match;
  if (!events) throw new Error("Missing match events");
  const restored = readMatchRecord(JSON.stringify(rebuildSnapshotMatch(match, events)), game);
  if (restored.game !== "shogi" && restored.game !== "four-shogi")
    verifyFinalState(restored.record);
  return restored;
}
