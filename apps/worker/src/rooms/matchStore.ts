import { prepareSnapshotMatch } from "./snapshotMatchStore";
import type { ProfileRatings } from "@tetraboard/protocol";
import { tournamentMatchStatements } from "../tournaments/store";
import { readStoredMatch } from "../accounts/matchDataContracts";
import {
  applyFourReversiRating,
  fourReversiRatingStore,
  type FourReversiRatedMatch,
} from "./fourReversiRating";
import type { TournamentRoomContext } from "./tournamentRoom";
import { redactParticipants } from "../privacy/identity";
import { applyMatchClaims } from "../accounts/matchClaims";
import type { MatchRecord as FourGomokuMatchRecord } from "./fourGomokuMatchStore";
import type { MatchRecord as GomokuMatchRecord } from "./gomokuMatchStore";
import { reversiRatingStatement, reversiRatingStore } from "./reversiRating";
import type { MatchRecord as ReversiMatchRecord } from "./reversiMatchStore";
import { badgeAwardStatements } from "../accounts/badgeAwards";
import {
  type FourReversiRoom as Room,
  type RoundReplay,
  type FourReversiMatchDetail,
} from "@tetraboard/protocol";

import { type FourReversiState } from "@tetraboard/four-reversi";

export type MatchParticipant = {
  id: string;
  name: string;
  color: NonNullable<Room["players"][number]["color"]>;
  seat: number;
} & (
  | { kind: "human"; accountId: string | null; retired?: true }
  | { kind: "cpu"; level: 1 | 2; cpuProfile?: import("@tetraboard/protocol").CpuProfile }
);

export type MatchStart = {
  profileRatings?: ProfileRatings;
  id: string;
  roomId: string;
  instanceId: string;
  startedAtMs: number;
  settings: FourReversiMatchDetail["settings"];
  participants: MatchParticipant[];
  fourReversiRating?: FourReversiRatedMatch;
};
export type MatchRecord = MatchStart & {
  endedAtMs: number;
  game: Extract<FourReversiState, { status: "finished" }>;
  eliminations: Room["eliminations"];
  replay: RoundReplay;
};
export type PendingMatch = {
  record: MatchRecord;
  tournament?: TournamentRoomContext;
  retryAtMs: number;
};
export const matchStartKey = "match-start";
export const pendingMatchPrefix = "match-pending:";

export async function writeMatch(
  db: D1Database,
  record: MatchRecord | ReversiMatchRecord | GomokuMatchRecord | FourGomokuMatchRecord,
  tournament?: TournamentRoomContext,
): Promise<void> {
  record = await redactParticipants(db, record);
  const prepared = await prepareSnapshotMatch(db, record);
  let tournamentStatements: D1PreparedStatement[] = [];
  if (tournament) {
    const canonical = prepared.canonical;
    if (canonical.game !== "four-reversi" && canonical.game !== "four-gomoku")
      throw new Error("Invalid tournament game");
    tournamentStatements = tournamentMatchStatements(db, tournament, canonical.record);
  }
  const statements: D1PreparedStatement[] = prepared.statement ? [prepared.statement] : [];
  // 再送の内容が異なっても、保存済みの本人情報を索引へ反映します。
  statements.push(
    db
      .prepare(`INSERT INTO account_match_history
    (account_id, match_id, mode, started_at_ms, game)
    SELECT json_extract(p.value, '$.accountId'), m.id, m.mode, m.started_at_ms, m.game
    FROM matches m, json_each(m.record_json, '$.participants') p
    WHERE m.id = ? AND json_extract(p.value, '$.kind') = 'human'
      AND json_extract(p.value, '$.accountId') IS NOT NULL
    ON CONFLICT(account_id, match_id) DO NOTHING`)
      .bind(record.id),
  );
  if (record.settings.game === "reversi" && "rating" in record && record.rating)
    statements.push(
      ...reversiRatingStore.finalize(db, record.id, reversiRatingStatement(db, record.id)),
    );
  statements.push(...badgeAwardStatements(db, record.settings.game, record.id));
  statements.push(...tournamentStatements);
  await db.batch(statements);
  const saved = await db
    .prepare("SELECT record_json FROM matches WHERE id = ? AND game = ?")
    .bind(record.id, record.settings.game)
    .first<{ record_json: string }>();
  if (!saved) throw new Error("Match publication was incomplete");
  if ("fourReversiRating" in record && record.fourReversiRating)
    await finalizeFourReversiRating(db, saved.record_json);
  if (
    tournament &&
    !(await db
      .prepare("SELECT 1 FROM tournament_matches WHERE id=? AND tournament_key=? AND phase='saved'")
      .bind(record.id, tournament.tournamentKey)
      .first())
  )
    throw new Error("Tournament result publication was incomplete");
  await db.prepare("DELETE FROM match_uploads WHERE id = ?").bind(record.id).run();
  await applyMatchClaims(db, record.id);
}

async function finalizeFourReversiRating(db: D1Database, json: string) {
  const canonical = readStoredMatch(json, "four-reversi");
  if (canonical.game !== "four-reversi") throw new Error("Invalid rated game");
  await applyFourReversiRating(db, canonical.record);
  await fourReversiRatingStore.clearPending(db, canonical.record.id).run();
}
