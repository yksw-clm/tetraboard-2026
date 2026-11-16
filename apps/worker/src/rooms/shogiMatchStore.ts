import {
  advanceMatchChunks,
  readMatchChunk,
  publishMatchStatement,
  type ChunkRow,
  matchChunkSize as chunkSize,
  type MatchSaveProgress,
} from "./matchChunks";
import type { ProfileRatings } from "@tetraboard/protocol";
import { normalizeLegacyShogiState } from "./normalizeLegacyShogiState";
import { ensureMatchUpload } from "./matchUploads";
import {
  applyFourShogiRating,
  fourShogiRatingStore,
  type FourShogiRatedMatch,
} from "./fourReversiRating";
import { redactParticipants } from "../privacy/identity";
import { applyMatchClaims } from "../accounts/matchClaims";
import { getMatchReplayContract, shogiMatchReplayPageSchema } from "@tetraboard/protocol";
import { badgeAwardStatements } from "../accounts/badgeAwards";
import { tournamentMatchStatements } from "../tournaments/store";
import { shogiRatingStatement, shogiRatingStore, type ShogiRatingSource } from "./shogiRating";
import type { TournamentRoomContext } from "./tournamentRoom";
import {
  fourShogiReplayEventSchema,
  type FourShogiMatchDetail,
  type FourShogiReplayEvent,
  type FourShogiMatchReplayPage,
  shogiReplayEventSchema,
  type ShogiReplayEvent,
  type ShogiMatchReplayPage,
  type ShogiMatchDetail,
} from "@tetraboard/protocol";
import { type Side } from "@tetraboard/four-shogi";
import {
  shogiFormationUsageSchema,
  isFormationMatchEligible,
  type ShogiFormationUsage,
} from "./shogiFormationUsage";

async function finalizeFourShogiRating(db: D1Database, json: string) {
  const record = readShogiMatchRecord(json);
  if (!record.fourShogiRating) return;
  await applyFourShogiRating(db, record);
  await fourShogiRatingStore.clearPending(db, record.id).run();
}

export type ShogiMatchParticipant = {
  id: string;
  name: string;
  side: Side;
  seat: number;
} & ({ kind: "human"; accountId: string | null; retired?: true } | { kind: "cpu"; level: 1 | 2 });
export type ShogiMatchStart = {
  profileRatings?: ProfileRatings;
  id: string;
  roomId: string;
  instanceId: string;
  startedAtMs: number;
  settings: FourShogiMatchDetail["settings"];
  participants: ShogiMatchParticipant[];
  fourShogiRating?: FourShogiRatedMatch;
};
export type ShogiMatchRecord = ShogiMatchStart & {
  endedAtMs: number;
  game: FourShogiMatchDetail["game"];
  knockouts: Record<Side, number>;
  replay: FourShogiMatchDetail["replay"];
};
export type ShogiSaveProgress = MatchSaveProgress;
export type PendingShogiMatch = {
  record: ShogiMatchRecord;
  tournament?: TournamentRoomContext;
  formationUsage?: ShogiFormationUsage;
  progress: ShogiSaveProgress;
  retryAtMs: number;
};
export type ActiveShogiMatch = {
  start: ShogiMatchStart;
  tournament?: TournamentRoomContext;
  knockouts: Record<Side, number>;
  formationUsage?: ShogiFormationUsage;
};
export const shogiMatchStartKey = "shogi-match-start";
export const pendingShogiMatchPrefix = "shogi-match-pending:";

export function emptyKnockouts(): Record<Side, number> {
  return { south: 0, west: 0, north: 0, east: 0 };
}

// 保存待ちの引分提案以外は、読取り用の正規化結果を保存manifestへ戻しません。
export { readFourShogiMatchRecord as readShogiMatchRecord } from "../accounts/matchDataContracts";
import { readFourShogiMatchRecord as readShogiMatchRecord } from "../accounts/matchDataContracts";

export type StandardShogiMatchRecord = {
  profileRatings?: ProfileRatings;
  id: string;
  roomId: string;
  instanceId: string;
  startedAtMs: number;
  endedAtMs: number;
  settings: ShogiMatchDetail["settings"];
  participants: ({ id: string; name: string; side: "south" | "north"; seat: number } & (
    | { kind: "human"; accountId: string | null; retired?: true }
    | { kind: "cpu"; level: 1 | 2 }
  ))[];
  game: ShogiMatchDetail["game"];
  replay: ShogiMatchDetail["replay"];
  rating?: ShogiRatingSource;
};
export const standardShogiMatchStartKey = "standard-shogi-match-start";
export const pendingStandardShogiMatchPrefix = "standard-shogi-match-pending:";
export type PendingStandardShogiMatch = {
  record: StandardShogiMatchRecord;
  progress: ShogiSaveProgress;
  retryAtMs: number;
};
import { shogiMatchData } from "../accounts/shogiMatchData";
type StoredEvent = FourShogiReplayEvent | ShogiReplayEvent;
function eventSchema(game: "four-shogi" | "shogi") {
  return game === "four-shogi" ? fourShogiReplayEventSchema : shogiReplayEventSchema;
}
function readRecord(json: string, game: "four-shogi" | "shogi") {
  return game === "four-shogi" ? readShogiMatchRecord(json) : shogiMatchData.read(json);
}
function readChunk(row: ChunkRow, eventCount: number, game: "four-shogi" | "shogi"): StoredEvent[] {
  return readMatchChunk(row, eventCount, (event) => eventSchema(game).parse(event));
}

/** 再送時も、1回の処理で転送・検証するイベントを最大400件に制限します。 */
export async function advanceShogiMatchSave(
  db: D1Database,
  record: ShogiMatchRecord | StandardShogiMatchRecord,
  progress: ShogiSaveProgress,
  readEvents: (cursor: number) => StoredEvent[],
  formationUsage?: ShogiFormationUsage,
  tournament?: TournamentRoomContext,
): Promise<ShogiSaveProgress | null> {
  record = await redactParticipants(db, normalizeLegacyShogiState(record) as typeof record);
  const game = record.settings.game;
  if (formationUsage) {
    shogiFormationUsageSchema.parse(formationUsage);
    if (
      game !== "four-shogi" ||
      !isFormationMatchEligible({
        settings: { mode: record.settings.mode ?? "standard" },
        participants: record.participants,
        rated: "fourShogiRating" in record && record.fourShogiRating !== undefined,
      })
    )
      throw new Error("Ineligible Shogi formation match");
  }
  const existing = await db
    .prepare("SELECT game, record_json FROM matches WHERE id = ?")
    .bind(record.id)
    .first<{ game: string; record_json: string }>();
  if (existing) {
    if (existing.game !== game) throw new Error("Match ID belongs to another game");
    if (tournament && game === "four-shogi") {
      await db.batch(
        tournamentMatchStatements(db, tournament, readShogiMatchRecord(existing.record_json)),
      );
      const saved = await db
        .prepare(
          "SELECT 1 FROM tournament_matches WHERE id=? AND tournament_key=? AND phase='saved'",
        )
        .bind(record.id, tournament.tournamentKey)
        .first();
      if (!saved) throw new Error("Tournament result publication was incomplete");
    }
    if (game === "four-shogi") await finalizeFourShogiRating(db, existing.record_json);
    await db.prepare("DELETE FROM match_uploads WHERE id = ?").bind(record.id).run();
    await applyMatchClaims(db, record.id);
    return null;
  }
  const chunkCount = Math.ceil(record.replay.eventCount / chunkSize);
  await ensureMatchUpload(db, record, chunkCount, "Conflicting Shogi match upload");
  const next = await advanceMatchChunks(
    db,
    record.id,
    record.replay.eventCount,
    progress,
    readEvents,
    (event) => eventSchema(game).parse(event),
  );
  if (next) return next;
  // 棋譜の検証後、本体・アカウント索引・レートを一緒に確定します。
  await db.batch([
    publishMatchStatement(db, record.id),
    db
      .prepare(`INSERT INTO account_match_history (account_id, match_id, mode, started_at_ms, game)
      SELECT json_extract(p.value, '$.accountId'), m.id, m.mode, m.started_at_ms, m.game
      FROM matches m, json_each(m.record_json, '$.participants') p
      WHERE m.id = ? AND m.game IN ('four-shogi', 'shogi') AND json_extract(p.value, '$.kind') = 'human'
        AND json_extract(p.value, '$.accountId') IS NOT NULL
      ON CONFLICT(account_id, match_id) DO NOTHING`)
      .bind(record.id),
    ...(formationUsage
      ? [
          db
            .prepare(`INSERT INTO four_shogi_formation_usages
      (match_id, analyzer_id, analysis_version, rules_version, used_by_side_json)
      SELECT id, ?, ?, ?, ? FROM matches WHERE id = ? AND game = 'four-shogi'
      ON CONFLICT(match_id) DO NOTHING`)
            .bind(
              formationUsage.analyzerId,
              formationUsage.analysisVersion,
              formationUsage.rulesVersion,
              JSON.stringify(formationUsage.bySide),
              record.id,
            ),
        ]
      : []),
    ...badgeAwardStatements(db, game, record.id),
    ...("rating" in record && record.rating
      ? shogiRatingStore.finalize(db, record.id, shogiRatingStatement(db, record.id))
      : []),
    ...(tournament && game === "four-shogi"
      ? tournamentMatchStatements(db, tournament, record as ShogiMatchRecord)
      : []),
  ]);
  const savedRecord = await db
    .prepare("SELECT record_json FROM matches WHERE id = ? AND game = ?")
    .bind(record.id, game)
    .first<{ record_json: string }>();
  if (!savedRecord) throw new Error("Shogi match publication was incomplete");
  if (game === "four-shogi") await finalizeFourShogiRating(db, savedRecord.record_json);
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
  return null;
}

export async function readShogiMatchReplayPage(
  db: D1Database,
  matchId: string,
  cursor: number,
  game: "four-shogi" | "shogi" = "four-shogi",
): Promise<
  Omit<FourShogiMatchReplayPage, "matchId"> | Omit<ShogiMatchReplayPage, "matchId"> | null
> {
  const row = await db
    .prepare("SELECT record_json FROM matches WHERE id = ? AND game = ?")
    .bind(matchId, game)
    .first<{ record_json: string }>();
  if (!row) return null;
  const record = readRecord(row.record_json, game);
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > record.replay.eventCount) return null;
  const count = Math.min(chunkSize, record.replay.eventCount - cursor);
  const events: { index: number; event: StoredEvent }[] = [];
  if (count > 0) {
    const first = Math.floor(cursor / chunkSize),
      last = Math.floor((cursor + count - 1) / chunkSize);
    const rows = await db
      .prepare(`SELECT chunk_index, start_index, event_count, events_json
      FROM match_event_chunks WHERE match_id = ? AND chunk_index BETWEEN ? AND ? ORDER BY chunk_index`)
      .bind(matchId, first, last)
      .all<ChunkRow>();
    if (rows.results.length !== last - first + 1)
      throw new Error("Missing stored Shogi replay chunk");
    for (const chunk of rows.results)
      for (const [offset, event] of readChunk(chunk, record.replay.eventCount, game).entries()) {
        const index = chunk.start_index + offset;
        if (index >= cursor && index < cursor + count) events.push({ index, event });
      }
    if (events.length !== count || events.some((event, i) => event.index !== cursor + i))
      throw new Error("Stored Shogi replay is not contiguous");
  }
  return (
    game === "four-shogi" ? getMatchReplayContract.response : shogiMatchReplayPageSchema
  ).parse({
    matchId,
    ...record.replay,
    events,
    nextCursor: cursor + count < record.replay.eventCount ? cursor + count : null,
  });
}
