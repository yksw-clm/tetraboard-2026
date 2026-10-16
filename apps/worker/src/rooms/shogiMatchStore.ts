import { redactParticipants } from "../privacy/identity";
import { applyMatchClaims } from "../accounts/matchClaims";
import { getMatchReplayContract, shogiMatchReplayPageSchema } from "@tetraboard/protocol";
import { badgeAwardStatements } from "../accounts/badgeAwards";
import { tournamentMatchStatements } from "../tournaments/store";
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

export type ShogiMatchParticipant = {
  id: string;
  name: string;
  side: Side;
  seat: number;
} & ({ kind: "human"; accountId: string | null; retired?: true } | { kind: "cpu"; level: 1 | 2 });
export type ShogiMatchStart = {
  id: string;
  roomId: string;
  instanceId: string;
  startedAtMs: number;
  settings: FourShogiMatchDetail["settings"];
  participants: ShogiMatchParticipant[];
};
export type ShogiMatchRecord = ShogiMatchStart & {
  endedAtMs: number;
  game: FourShogiMatchDetail["game"];
  knockouts: Record<Side, number>;
  replay: FourShogiMatchDetail["replay"];
};
export type ShogiSaveProgress = { phase: "upload" | "verify"; cursor: number };
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
const chunkSize = 100;
const chunksPerPass = 4;

export function emptyKnockouts(): Record<Side, number> {
  return { south: 0, west: 0, north: 0, east: 0 };
}

// 読取り用の正規化結果は保存manifestの照合文字列に使用しません。
export { readFourShogiMatchRecord as readShogiMatchRecord } from "../accounts/matchDataContracts";
import { readFourShogiMatchRecord as readShogiMatchRecord } from "../accounts/matchDataContracts";

export type StandardShogiMatchRecord = {
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
type ChunkRow = {
  chunk_index: number;
  start_index: number;
  event_count: number;
  events_json: string;
};
function readChunk(row: ChunkRow, eventCount: number, game: "four-shogi" | "shogi"): StoredEvent[] {
  const events = JSON.parse(row.events_json) as unknown;
  const expected = Math.min(chunkSize, eventCount - row.chunk_index * chunkSize);
  if (
    !Number.isInteger(row.chunk_index) ||
    row.chunk_index < 0 ||
    row.start_index !== row.chunk_index * chunkSize ||
    expected <= 0 ||
    row.event_count !== expected ||
    !Array.isArray(events) ||
    events.length !== expected
  )
    throw new Error("Shogi replay chunk is incomplete");
  return events.map((event) => eventSchema(game).parse(event));
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
  record = await redactParticipants(db, record);
  const game = record.settings.game;
  if (formationUsage) {
    shogiFormationUsageSchema.parse(formationUsage);
    if (
      game !== "four-shogi" ||
      !isFormationMatchEligible({
        settings: { mode: record.settings.mode ?? "standard" },
        participants: record.participants,
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
    await db.prepare("DELETE FROM shogi_match_uploads WHERE id = ?").bind(record.id).run();
    await applyMatchClaims(db, record.id);
    return null;
  }
  const canonical = JSON.stringify(record);
  readRecord(canonical, game);
  const chunkCount = Math.ceil(record.replay.eventCount / chunkSize);
  await db
    .prepare(`INSERT INTO shogi_match_uploads VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING`)
    .bind(record.id, canonical, record.replay.eventCount, chunkCount)
    .run();
  const upload = await db
    .prepare("SELECT record_json FROM shogi_match_uploads WHERE id = ?")
    .bind(record.id)
    .first<{ record_json: string }>();
  if (upload?.record_json !== canonical) throw new Error("Conflicting Shogi match upload");
  if (!Number.isInteger(progress.cursor) || progress.cursor < 0 || progress.cursor > chunkCount)
    throw new Error("Invalid Shogi save progress");
  const end = Math.min(progress.cursor + chunksPerPass, chunkCount);
  if (progress.phase === "upload") {
    for (let index = progress.cursor; index < end; index++) {
      const events = readEvents(index * chunkSize);
      const row: ChunkRow = {
        chunk_index: index,
        start_index: index * chunkSize,
        event_count: events.length,
        events_json: JSON.stringify(events),
      };
      readChunk(row, record.replay.eventCount, game);
      await db
        .prepare(`INSERT INTO shogi_match_chunks VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(match_id, chunk_index) DO NOTHING`)
        .bind(record.id, index, row.start_index, row.event_count, row.events_json)
        .run();
    }
    return end === chunkCount ? { phase: "verify", cursor: 0 } : { phase: "upload", cursor: end };
  }
  const rows = await db
    .prepare(`SELECT chunk_index, start_index, event_count, events_json
    FROM shogi_match_chunks WHERE match_id = ? AND chunk_index >= ? AND chunk_index < ?
    ORDER BY chunk_index`)
    .bind(record.id, progress.cursor, end)
    .all<ChunkRow>();
  if (rows.results.length !== end - progress.cursor) throw new Error("Missing Shogi replay chunk");
  for (const [offset, row] of rows.results.entries()) {
    if (row.chunk_index !== progress.cursor + offset) throw new Error("Shogi chunk index mismatch");
    const stored = readChunk(row, record.replay.eventCount, game);
    const expected = readEvents(row.start_index).map((event) => eventSchema(game).parse(event));
    if (JSON.stringify(stored) !== JSON.stringify(expected))
      throw new Error("Shogi chunk content mismatch");
  }
  if (end < chunkCount) return { phase: "verify", cursor: end };
  // 不変の棋譜行をすべて検証した後、本体と全アカウント索引を一緒に確定します。
  await db.batch([
    db
      .prepare(`INSERT INTO matches (id, game, mode, started_at_ms, ended_at_ms, record_json)
      SELECT id, json_extract(record_json, '$.settings.game'), COALESCE(json_extract(record_json, '$.settings.mode'), 'standard'),
        json_extract(record_json, '$.startedAtMs'), json_extract(record_json, '$.endedAtMs'), record_json
      FROM shogi_match_uploads u WHERE id = ?
        AND (SELECT COUNT(*) FROM shogi_match_chunks WHERE match_id = u.id) = u.chunk_count
        AND COALESCE((SELECT SUM(event_count) FROM shogi_match_chunks WHERE match_id = u.id), 0) = u.event_count
      ON CONFLICT(id) DO NOTHING`)
      .bind(record.id),
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
            .prepare(`INSERT INTO shogi_match_formations
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
    ...(tournament && game === "four-shogi"
      ? tournamentMatchStatements(db, tournament, record as ShogiMatchRecord)
      : []),
  ]);
  if (!(await db.prepare("SELECT id FROM matches WHERE id = ?").bind(record.id).first()))
    throw new Error("Shogi match publication was incomplete");
  if (
    tournament &&
    !(await db
      .prepare("SELECT 1 FROM tournament_matches WHERE id=? AND tournament_key=? AND phase='saved'")
      .bind(record.id, tournament.tournamentKey)
      .first())
  )
    throw new Error("Tournament result publication was incomplete");
  await db.prepare("DELETE FROM shogi_match_uploads WHERE id = ?").bind(record.id).run();
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
      FROM shogi_match_chunks WHERE match_id = ? AND chunk_index BETWEEN ? AND ? ORDER BY chunk_index`)
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
