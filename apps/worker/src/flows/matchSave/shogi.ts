import { applyFourShogiRating } from "./skillRating";
import { prepareEloRating } from "@tetraboard/context-rating";
import { D1RatingPublication } from "../../adapters/rating/publication";
import {
  advanceShogiMatchSave as advanceRecordSave,
  type MatchSaveProgress,
} from "@tetraboard/context-record";
import {
  fourShogiReplayEventSchema,
  shogiReplayEventSchema,
  type FourShogiReplayEvent,
  type ShogiReplayEvent,
} from "@tetraboard/protocol";
import { D1MatchRecordStore } from "../../adapters/record/matchRecordStore";
import {
  readPublishedMatch,
  deleteMatchUpload,
  tournamentResultIsSaved,
  shogiHistoryStatement,
  formationUsageStatement,
} from "../../adapters/record/publication";
import { redactParticipants } from "../../privacy/identity";
import { applyMatchClaims } from "../../accounts/matchClaims";
import { badgeAwardStatements } from "../../accounts/badgeAwards";
import { tournamentMatchStatements } from "../../tournaments/store";
import { fourShogiRatingStore } from "../../rooms/fourReversiRating";
import {
  readShogiMatchRecord,
  type ShogiMatchRecord,
  type StandardShogiMatchRecord,
} from "../../rooms/shogiMatchStore";
import {
  shogiFormationUsageSchema,
  isFormationMatchEligible,
  type ShogiFormationUsage,
} from "../../rooms/shogiFormationUsage";
import type { TournamentRoomContext } from "../../rooms/tournamentRoom";
import { normalizeMatchUpload } from "./validation";

type ShogiRecord = ShogiMatchRecord | StandardShogiMatchRecord;

export async function advanceShogiMatchSave(
  db: D1Database,
  record: ShogiRecord,
  progress: MatchSaveProgress,
  readEvents: (cursor: number) => (FourShogiReplayEvent | ShogiReplayEvent)[],
  formationUsage?: ShogiFormationUsage,
  tournament?: TournamentRoomContext,
): Promise<MatchSaveProgress | null> {
  record = await redactParticipants(db, record);
  validateFormationUsage(record, formationUsage);
  const game = record.settings.game;
  const prepared = await advanceRecordSave(
    new D1MatchRecordStore(db),
    record,
    progress,
    readEvents,
    (event) =>
      (game === "four-shogi" ? fourShogiReplayEventSchema : shogiReplayEventSchema).parse(event),
    normalizeMatchUpload(db, game),
  );
  if (prepared.status === "progress") return prepared.progress;
  if (prepared.status === "saved") {
    await finishSavedShogiMatch(db, record, prepared.saved.recordJson, tournament);
    return null;
  }
  await publishShogiMatch(db, record, prepared.statement, formationUsage, tournament);
  const saved = await readPublishedMatch(db, record.id, game);
  if (!saved) throw new Error("Shogi match publication was incomplete");
  if (game === "four-shogi") await finalizeFourShogiRating(db, saved);
  await verifyTournamentResult(db, record.id, tournament);
  await deleteMatchUpload(db, record.id);
  await applyMatchClaims(db, record.id);
  return null;
}

function validateFormationUsage(record: ShogiRecord, usage?: ShogiFormationUsage) {
  if (!usage) return;
  shogiFormationUsageSchema.parse(usage);
  if (
    record.settings.game !== "four-shogi" ||
    !isFormationMatchEligible({
      settings: { mode: record.settings.mode ?? "standard" },
      participants: record.participants,
      rated: "fourShogiRating" in record && record.fourShogiRating !== undefined,
    })
  )
    throw new Error("Ineligible Shogi formation match");
}

async function finishSavedShogiMatch(
  db: D1Database,
  record: ShogiRecord,
  json: string,
  tournament?: TournamentRoomContext,
) {
  if (tournament && record.settings.game === "four-shogi") {
    await db.batch(tournamentMatchStatements(db, tournament, readShogiMatchRecord(json)));
    await verifyTournamentResult(db, record.id, tournament);
  }
  if (record.settings.game === "four-shogi") await finalizeFourShogiRating(db, json);
  await deleteMatchUpload(db, record.id);
  await applyMatchClaims(db, record.id);
}

async function publishShogiMatch(
  db: D1Database,
  record: ShogiRecord,
  publication: D1PreparedStatement,
  formationUsage?: ShogiFormationUsage,
  tournament?: TournamentRoomContext,
) {
  // 棋譜の検証後、本体・アカウント索引・レートを一緒に確定します。
  await db.batch([
    publication,
    shogiHistoryStatement(db, record.id),
    ...(formationUsage ? [formationUsageStatement(db, record.id, formationUsage)] : []),
    ...badgeAwardStatements(db, record.settings.game, record.id),
    ...("rating" in record && record.rating
      ? prepareEloRating(new D1RatingPublication(db), "shogi", record.id)
      : []),
    ...(tournament && record.settings.game === "four-shogi"
      ? tournamentMatchStatements(db, tournament, record as ShogiMatchRecord)
      : []),
  ]);
}

async function verifyTournamentResult(
  db: D1Database,
  matchId: string,
  tournament?: TournamentRoomContext,
) {
  if (tournament && !(await tournamentResultIsSaved(db, matchId, tournament.tournamentKey)))
    throw new Error("Tournament result publication was incomplete");
}

async function finalizeFourShogiRating(db: D1Database, json: string) {
  const record = readShogiMatchRecord(json);
  if (!record.fourShogiRating) return;
  await applyFourShogiRating(db, record);
  await fourShogiRatingStore.clearPending(db, record.id).run();
}
