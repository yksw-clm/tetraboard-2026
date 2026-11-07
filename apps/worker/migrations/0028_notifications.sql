CREATE TABLE notification_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK(kind IN ('announcement','tournament','badge')),
  source_id TEXT NOT NULL,
  account_id TEXT NOT NULL DEFAULT '',
  created_at_ms INTEGER NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  legacy INTEGER NOT NULL DEFAULT 0,
  UNIQUE(kind,source_id,account_id)
);
CREATE INDEX notification_events_account ON notification_events(account_id,seq);
CREATE TABLE account_notification_state (
  account_id TEXT PRIMARY KEY,
  baseline_seq INTEGER NOT NULL,
  read_all_seq INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE account_notification_reads (
  account_id TEXT NOT NULL,
  notification_seq INTEGER NOT NULL REFERENCES notification_events(seq) ON DELETE CASCADE,
  PRIMARY KEY(account_id,notification_seq)
);
INSERT INTO notification_events(kind,source_id,created_at_ms,legacy)
SELECT 'announcement',id,created_at_ms,1 FROM announcements WHERE published=1 ORDER BY date,created_at_ms,id;
CREATE TRIGGER notification_announcement_insert AFTER INSERT ON announcements WHEN NEW.published=1 BEGIN
  INSERT OR IGNORE INTO notification_events(kind,source_id,created_at_ms) VALUES('announcement',NEW.id,NEW.updated_at_ms);
END;
CREATE TRIGGER notification_announcement_publish AFTER UPDATE OF published ON announcements WHEN NEW.published=1 BEGIN
  INSERT OR IGNORE INTO notification_events(kind,source_id,created_at_ms) VALUES('announcement',NEW.id,NEW.updated_at_ms);
END;
-- 旧toastの再送・ゲスト統合で導入前の通知を生成しません。
CREATE TABLE notification_metadata (key TEXT PRIMARY KEY,value INTEGER NOT NULL);
INSERT INTO notification_metadata VALUES('started_at_ms',CAST(unixepoch('subsec')*1000 AS INTEGER));
CREATE TRIGGER notification_badge AFTER INSERT ON account_badge_notifications
WHEN NEW.created_at_ms >= (SELECT value FROM notification_metadata WHERE key='started_at_ms')
AND NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE id=NEW.account_id) BEGIN
  INSERT OR IGNORE INTO notification_events(kind,source_id,account_id,created_at_ms,payload_json)
  SELECT 'badge',NEW.match_id,NEW.account_id,NEW.created_at_ms,
    json_object('id',NEW.match_id,'game',NEW.game,'badges',json_group_array(json_object(
      'id',badge_id,'tier',tier,'previousTier',previous_tier,'value',value)))
  FROM (SELECT badge_id,MAX(tier) AS tier,MIN(previous_tier) AS previous_tier,MAX(value) AS value
    FROM account_badge_awards WHERE account_id=NEW.account_id AND match_id=NEW.match_id GROUP BY badge_id)
  HAVING COUNT(*)>0;
END;
CREATE TRIGGER notification_privacy_insert BEFORE INSERT ON notification_events
WHEN NEW.account_id!='' AND EXISTS(SELECT 1 FROM deleted_accounts WHERE id=NEW.account_id) BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER notification_privacy_update BEFORE UPDATE ON notification_events
WHEN NEW.account_id!='' AND EXISTS(SELECT 1 FROM deleted_accounts WHERE id=NEW.account_id) BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER notification_state_privacy BEFORE INSERT ON account_notification_state
WHEN EXISTS(SELECT 1 FROM deleted_accounts WHERE id=NEW.account_id) BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER notification_reads_privacy BEFORE INSERT ON account_notification_reads
WHEN EXISTS(SELECT 1 FROM deleted_accounts WHERE id=NEW.account_id) BEGIN SELECT RAISE(IGNORE); END;
