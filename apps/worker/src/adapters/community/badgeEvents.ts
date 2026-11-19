import { accountNotDeletedSql } from "../../db/deletionGuard";

export function badgeEventStatement(db: D1Database, matchId: string) {
  // 直前の INSERT で採番された行だけを対象にし、既存の台帳を再送で通知し直さない。
  return db
    .prepare(`WITH added AS (
 SELECT rowid AS toast_rowid,account_id,match_id,game,created_at_ms
 FROM account_badge_notifications ORDER BY rowid DESC LIMIT changes()
 ), awards AS (
 SELECT n.toast_rowid,n.account_id,n.match_id,n.game,n.created_at_ms,a.badge_id,
   MAX(a.tier) AS tier,MIN(a.previous_tier) AS previous_tier,MAX(a.value) AS value
 FROM added n JOIN account_badge_awards a ON a.account_id=n.account_id AND a.match_id=n.match_id
 WHERE n.match_id=? AND n.created_at_ms >= (SELECT value FROM notification_metadata WHERE key='started_at_ms')
 AND NOT EXISTS(SELECT 1 FROM notification_events WHERE kind='badge' AND source_id=n.match_id AND account_id=n.account_id)
 GROUP BY n.toast_rowid,a.badge_id
 )
 INSERT OR IGNORE INTO notification_events(kind,source_id,account_id,created_at_ms,payload_json)
 SELECT 'badge',match_id,account_id,created_at_ms,
   json_object('id',match_id,'game',game,'badges',json_group_array(
     json_object('id',badge_id,'tier',tier,'previousTier',previous_tier,'value',value) ORDER BY badge_id))
 FROM awards WHERE ${accountNotDeletedSql("awards.account_id")}
 GROUP BY toast_rowid ORDER BY toast_rowid`)
    .bind(matchId);
}
