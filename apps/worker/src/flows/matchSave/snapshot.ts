import { applyFourReversiRating } from "./skillRating";
import { prepareEloRating } from "@tetraboard/context-rating";
import { D1RatingPublication } from "../../adapters/rating/publication";
import { prepareSnapshotMatch } from "@tetraboard/context-record";
import { D1MatchRecordStore } from "../../adapters/record/matchRecordStore";
import {
  readPublishedMatch,
  deleteMatchUpload,
  tournamentResultIsSaved,
  snapshotHistoryStatement,
} from "../../adapters/record/publication";
import { encodeValidatedSnapshot, normalizeMatchUpload } from "./validation";
import { matchEventSchema } from "../../adapters/record/snapshotMatchEvents";
import type { MatchRecord } from "../../adapters/record/matchStore";
import { tournamentMatchStatements } from "../../adapters/tournament/store";
import { readStoredMatch } from "../../adapters/record/matchDataContracts";
import { fourReversiRatingStore } from "../../adapters/rating/fourReversiRating";
import type { TournamentRoomContext } from "@tetraboard/context-tournament";
import { redactParticipants } from "../accountPurge/redactParticipants";
import { applyMatchClaims } from "./claims";
import type { MatchRecord as FourGomokuMatchRecord } from "../../adapters/record/fourGomokuMatchStore";
import type { MatchRecord as GomokuMatchRecord } from "../../adapters/record/gomokuMatchStore";
import type { MatchRecord as ReversiMatchRecord } from "../../adapters/record/reversiMatchStore";
import { matchBadgeStatements } from "./badges";
export async function writeMatch(
  db: D1Database,
  record: MatchRecord | ReversiMatchRecord | GomokuMatchRecord | FourGomokuMatchRecord,
  tournament?: TournamentRoomContext,
): Promise<void> {
  record = await redactParticipants(db, record);
  const prepared = await prepareSnapshotMatch(new D1MatchRecordStore(db), record, {
    readStored: readStoredMatch,
    encode: encodeValidatedSnapshot,
    parse: (event) => matchEventSchema(record.settings.game).parse(event),
    normalize: normalizeMatchUpload(db, record.settings.game),
  });
  let tournamentStatements: D1PreparedStatement[] = [];
  if (tournament) {
    const canonical = prepared.canonical;
    if (canonical.game !== "four-reversi" && canonical.game !== "four-gomoku")
      throw new Error("Invalid tournament game");
    tournamentStatements = tournamentMatchStatements(db, tournament, canonical.record);
  }
  const statements: D1PreparedStatement[] = prepared.statement ? [prepared.statement] : [];
  // 再送の内容が異なっても、保存済みの本人情報を索引へ反映します。
  statements.push(snapshotHistoryStatement(db, record.id));
  if (record.settings.game === "reversi" && "rating" in record && record.rating)
    statements.push(...prepareEloRating(new D1RatingPublication(db), "reversi", record.id));
  statements.push(...matchBadgeStatements(db, record.settings.game, record.id));
  statements.push(...tournamentStatements);
  await db.batch(statements);
  await finishSnapshotMatch(db, record, tournament);
}

async function finishSnapshotMatch(
  db: D1Database,
  record: MatchRecord | ReversiMatchRecord | GomokuMatchRecord | FourGomokuMatchRecord,
  tournament?: TournamentRoomContext,
) {
  const saved = await readPublishedMatch(db, record.id, record.settings.game);
  if (!saved) throw new Error("Match publication was incomplete");
  if ("fourReversiRating" in record && record.fourReversiRating)
    await finalizeFourReversiRating(db, saved);
  if (tournament && !(await tournamentResultIsSaved(db, record.id, tournament.tournamentKey)))
    throw new Error("Tournament result publication was incomplete");
  await deleteMatchUpload(db, record.id);
  await applyMatchClaims(db, record.id);
}
async function finalizeFourReversiRating(db: D1Database, json: string) {
  const canonical = readStoredMatch(json, "four-reversi");
  if (canonical.game !== "four-reversi") throw new Error("Invalid rated game");
  await applyFourReversiRating(db, canonical.record);
  await fourReversiRatingStore.clearPending(db, canonical.record.id).run();
}
