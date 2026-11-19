import { accountNotDeletedSql } from "../../db/deletionGuard";
import type { ShogiFormationUsage } from "../../rooms/shogiFormationUsage";
import { mergedAccountIdSql } from "./guestMerges";

export function snapshotHistoryStatement(db: D1Database, matchId: string) {
  return db
    .prepare(`INSERT INTO account_match_history
    (account_id, match_id, mode, started_at_ms, game)
    SELECT ${mergedAccountIdSql("json_extract(p.value, '$.accountId')")}, m.id, m.mode, m.started_at_ms, m.game
    FROM matches m, json_each(m.record_json, '$.participants') p
    WHERE m.id = ? AND json_extract(p.value, '$.kind') = 'human'
      AND json_extract(p.value, '$.accountId') IS NOT NULL
      AND ${accountNotDeletedSql(mergedAccountIdSql("json_extract(p.value, '$.accountId')"))}
    ON CONFLICT(account_id, match_id) DO NOTHING`)
    .bind(matchId);
}

export function shogiHistoryStatement(db: D1Database, matchId: string) {
  return db
    .prepare(`INSERT INTO account_match_history (account_id, match_id, mode, started_at_ms, game)
      SELECT ${mergedAccountIdSql("json_extract(p.value, '$.accountId')")}, m.id, m.mode, m.started_at_ms, m.game
      FROM matches m, json_each(m.record_json, '$.participants') p
      WHERE m.id = ? AND m.game IN ('four-shogi', 'shogi') AND json_extract(p.value, '$.kind') = 'human'
        AND json_extract(p.value, '$.accountId') IS NOT NULL
        AND ${accountNotDeletedSql(mergedAccountIdSql("json_extract(p.value, '$.accountId')"))}
      ON CONFLICT(account_id, match_id) DO NOTHING`)
    .bind(matchId);
}

export function formationUsageStatement(
  db: D1Database,
  matchId: string,
  usage: ShogiFormationUsage,
) {
  return db
    .prepare(`INSERT INTO four_shogi_formation_usages
      (match_id, analyzer_id, analysis_version, rules_version, used_by_side_json)
      SELECT id, ?, ?, ?, ? FROM matches WHERE id = ? AND game = 'four-shogi'
      ON CONFLICT(match_id) DO NOTHING`)
    .bind(
      usage.analyzerId,
      usage.analysisVersion,
      usage.rulesVersion,
      JSON.stringify(usage.bySide),
      matchId,
    );
}

export async function readPublishedMatch(db: D1Database, matchId: string, game: string) {
  const saved = await db
    .prepare("SELECT record_json FROM matches WHERE id = ? AND game = ?")
    .bind(matchId, game)
    .first<{ record_json: string }>();
  return saved?.record_json ?? null;
}

export async function tournamentResultIsSaved(db: D1Database, matchId: string, key: string) {
  return db
    .prepare("SELECT 1 FROM tournament_matches WHERE id=? AND tournament_key=? AND phase='saved'")
    .bind(matchId, key)
    .first();
}

export async function deleteMatchUpload(db: D1Database, matchId: string) {
  await db.prepare("DELETE FROM match_uploads WHERE id = ?").bind(matchId).run();
}
