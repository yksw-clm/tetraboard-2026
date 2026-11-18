import { badgeAwardsSql } from "../../accounts/badgeAwards";

export function guestReplayTransferStatements(db: D1Database, guestId: string, targetId: string) {
  // 公開棋譜の本人参照だけを移し、手順・日時・結果を保持します。
  return ["matches", "match_uploads"].map((table) =>
    db
      .prepare(`UPDATE ${table} SET record_json=json_set(record_json,'$.participants',json((
      SELECT json_group_array(json(CASE WHEN json_extract(p.value,'$.accountId')=? THEN json_set(p.value,'$.accountId',?) ELSE p.value END))
      FROM json_each(${table}.record_json,'$.participants') p)))
      WHERE EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(${table}.record_json) THEN ${table}.record_json ELSE '{}' END,'$.participants') p WHERE json_extract(p.value,'$.accountId')=?)`)
      .bind(guestId, targetId, guestId),
  );
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
