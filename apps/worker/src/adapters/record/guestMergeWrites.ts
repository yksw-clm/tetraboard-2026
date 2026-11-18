import { badgeAwardsSql } from "./badgeAwards";
import { scrubbedRecordJsonSql } from "./privacyScrub";

export function guestReplayTransferStatements(db: D1Database, guestId: string, targetId: string) {
  // 公開棋譜の本人参照だけを移し、手順・日時・結果を保持します。
  const transferredJson = `json_set(record_json, '$.participants', json((
    SELECT json_group_array(json(CASE WHEN json_extract(p.value, '$.accountId') = ?1
      THEN json_set(p.value, '$.accountId', ?2) ELSE p.value END))
    FROM json_each(record_json, '$.participants') p)))`;
  const where = `EXISTS (
    SELECT 1 FROM json_each(CASE WHEN json_valid(record_json) THEN record_json ELSE '{}' END, '$.participants') p
    WHERE json_extract(p.value, '$.accountId') = ?1
  )`;
  return [
    db
      .prepare(`UPDATE matches SET record_json = ${scrubbedRecordJsonSql(transferredJson, "matches.id")}
      WHERE ${where}`)
      .bind(guestId, targetId),
    db
      .prepare(`UPDATE match_uploads SET record_json = ${scrubbedRecordJsonSql(transferredJson, "match_uploads.id")}
      WHERE ${where}`)
      .bind(guestId, targetId),
  ];
}

export function guestMatchAccountTransferStatements(
  db: D1Database,
  guestId: string,
  targetId: string,
) {
  return [
    db
      .prepare("UPDATE account_match_history SET account_id=? WHERE account_id=?")
      .bind(targetId, guestId),
    db
      .prepare("UPDATE match_participant_accounts SET account_id=? WHERE account_id=?")
      .bind(targetId, guestId),
  ];
}

export function guestBadgeTransferStatements(db: D1Database, guestId: string, targetId: string) {
  return [
    db
      .prepare(
        `INSERT OR IGNORE INTO account_badge_awards SELECT ?,game,badge_id,tier,value,previous_tier,match_id FROM account_badge_awards WHERE account_id=?`,
      )
      .bind(targetId, guestId),
    db
      .prepare(
        `INSERT OR IGNORE INTO account_badge_notifications SELECT ?,match_id,game,created_at_ms,shown_at_ms,NULL,NULL FROM account_badge_notifications WHERE account_id=?`,
      )
      .bind(targetId, guestId),
    db.prepare("DELETE FROM account_badge_awards WHERE account_id=?").bind(guestId),
    db.prepare("DELETE FROM account_badge_notifications WHERE account_id=?").bind(guestId),
    db.prepare(badgeAwardsSql("four-reversi", true, true)).bind("four-reversi", targetId),
    db.prepare(badgeAwardsSql("four-shogi", true, true)).bind("four-shogi", targetId),
  ];
}
