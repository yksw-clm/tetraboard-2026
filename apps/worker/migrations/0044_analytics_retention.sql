-- 起点時点の区分は終局保存待ちから受け取り、現在のプロフィールで補いません。
ALTER TABLE analytics_participants ADD COLUMN completion_is_guest INTEGER;
CREATE TABLE analytics_retention_accounts(account_id TEXT PRIMARY KEY,revision INTEGER NOT NULL DEFAULT 1);
CREATE TABLE analytics_retention_dirty_days(day TEXT PRIMARY KEY,revision INTEGER NOT NULL DEFAULT 1);
CREATE TABLE analytics_retention_subjects (
 account_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE, metric TEXT NOT NULL,game TEXT NOT NULL,
 origin_match_id TEXT NOT NULL,origin_at_ms INTEGER NOT NULL,day TEXT NOT NULL,kind TEXT NOT NULL,is_internal INTEGER NOT NULL,
 until_ms INTEGER NOT NULL,expires_at_ms INTEGER NOT NULL,next_check_at_ms INTEGER,evaluated_at_ms INTEGER NOT NULL DEFAULT 0,
 enrolled INTEGER NOT NULL DEFAULT 1,eligible INTEGER NOT NULL DEFAULT 0,retained INTEGER NOT NULL DEFAULT 0,retained_next_day INTEGER NOT NULL DEFAULT 0,
 observing INTEGER NOT NULL DEFAULT 0,unknown INTEGER NOT NULL DEFAULT 0,
 reached1 INTEGER NOT NULL DEFAULT 0,reached2 INTEGER NOT NULL DEFAULT 0,reached3 INTEGER NOT NULL DEFAULT 0,reached4 INTEGER NOT NULL DEFAULT 0,reached5 INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(account_id,metric,game)
);
CREATE INDEX retention_subject_due ON analytics_retention_subjects(next_check_at_ms);
CREATE INDEX retention_subject_expiry ON analytics_retention_subjects(expires_at_ms);
CREATE INDEX retention_subject_day ON analytics_retention_subjects(day);
CREATE INDEX retention_participant_origin_match ON analytics_participants(origin_account_id,match_id);
CREATE TABLE analytics_retention_daily (
 day TEXT NOT NULL,metric TEXT NOT NULL,game TEXT NOT NULL,kind TEXT NOT NULL,internal INTEGER NOT NULL,
 enrolled INTEGER NOT NULL,eligible INTEGER NOT NULL,retained INTEGER NOT NULL,retained_next_day INTEGER NOT NULL,
 observing INTEGER NOT NULL,unknown INTEGER NOT NULL,
 reached1 INTEGER NOT NULL,reached2 INTEGER NOT NULL,reached3 INTEGER NOT NULL,reached4 INTEGER NOT NULL,reached5 INTEGER NOT NULL,
 PRIMARY KEY(day,metric,game,kind,internal)
);
CREATE TABLE analytics_retention_archive AS SELECT * FROM analytics_retention_daily WHERE 0;
CREATE UNIQUE INDEX retention_archive_key ON analytics_retention_archive(day,metric,game,kind,internal);
INSERT INTO analytics_metadata(key,value) VALUES('retention_collected_from',CAST(unixepoch('subsec')*1000 AS INTEGER));
CREATE TRIGGER retention_delete_account AFTER INSERT ON deleted_accounts BEGIN
 DELETE FROM analytics_retention_subjects WHERE account_id=NEW.id;
 DELETE FROM analytics_retention_accounts WHERE account_id=NEW.id;
END;
-- 別アカウントへの統合で分析の本人・起点・区分を書き換えません。
CREATE TRIGGER retention_merge_account AFTER INSERT ON guest_account_merges BEGIN
 INSERT INTO analytics_retention_accounts(account_id) VALUES(NEW.guest_id) ON CONFLICT(account_id) DO UPDATE SET revision=revision+1;
 INSERT INTO analytics_retention_accounts(account_id) VALUES(NEW.account_id) ON CONFLICT(account_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER retention_subject_insert AFTER INSERT ON analytics_retention_subjects BEGIN
 INSERT INTO analytics_retention_dirty_days(day) VALUES(NEW.day) ON CONFLICT(day) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER retention_subject_delete AFTER DELETE ON analytics_retention_subjects BEGIN
 INSERT INTO analytics_retention_dirty_days(day) VALUES(OLD.day) ON CONFLICT(day) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER retention_subject_update AFTER UPDATE ON analytics_retention_subjects BEGIN
 INSERT INTO analytics_retention_dirty_days(day) VALUES(OLD.day) ON CONFLICT(day) DO UPDATE SET revision=revision+1;
 INSERT INTO analytics_retention_dirty_days(day) VALUES(NEW.day) ON CONFLICT(day) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER retention_account_match_history_insert AFTER INSERT ON account_match_history BEGIN
 INSERT INTO analytics_retention_accounts(account_id) SELECT NEW.account_id WHERE NEW.account_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE id=NEW.account_id) ON CONFLICT(account_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER retention_account_match_history_delete AFTER DELETE ON account_match_history BEGIN
 INSERT INTO analytics_retention_accounts(account_id) SELECT OLD.account_id WHERE OLD.account_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE id=OLD.account_id) ON CONFLICT(account_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER retention_account_match_history_update AFTER UPDATE ON account_match_history BEGIN
 INSERT INTO analytics_retention_accounts(account_id) SELECT OLD.account_id WHERE OLD.account_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE id=OLD.account_id) ON CONFLICT(account_id) DO UPDATE SET revision=revision+1;
 INSERT INTO analytics_retention_accounts(account_id) SELECT NEW.account_id WHERE NEW.account_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE id=NEW.account_id) ON CONFLICT(account_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER retention_analytics_participants_insert AFTER INSERT ON analytics_participants BEGIN
 INSERT INTO analytics_retention_accounts(account_id) SELECT NEW.origin_account_id WHERE NEW.origin_account_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE id=NEW.origin_account_id) ON CONFLICT(account_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER retention_analytics_participants_delete AFTER DELETE ON analytics_participants BEGIN
 INSERT INTO analytics_retention_accounts(account_id) SELECT OLD.origin_account_id WHERE OLD.origin_account_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE id=OLD.origin_account_id) ON CONFLICT(account_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER retention_analytics_participants_update AFTER UPDATE ON analytics_participants BEGIN
 INSERT INTO analytics_retention_accounts(account_id) SELECT OLD.origin_account_id WHERE OLD.origin_account_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE id=OLD.origin_account_id) ON CONFLICT(account_id) DO UPDATE SET revision=revision+1;
 INSERT INTO analytics_retention_accounts(account_id) SELECT NEW.origin_account_id WHERE NEW.origin_account_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE id=NEW.origin_account_id) ON CONFLICT(account_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER retention_shogi_rating_changes_insert AFTER INSERT ON shogi_rating_changes BEGIN
 INSERT INTO analytics_retention_accounts(account_id) SELECT NEW.account_id WHERE NEW.account_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE id=NEW.account_id) ON CONFLICT(account_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER retention_shogi_rating_changes_delete AFTER DELETE ON shogi_rating_changes BEGIN
 INSERT INTO analytics_retention_accounts(account_id) SELECT OLD.account_id WHERE OLD.account_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE id=OLD.account_id) ON CONFLICT(account_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER retention_shogi_rating_changes_update AFTER UPDATE ON shogi_rating_changes BEGIN
 INSERT INTO analytics_retention_accounts(account_id) SELECT OLD.account_id WHERE OLD.account_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE id=OLD.account_id) ON CONFLICT(account_id) DO UPDATE SET revision=revision+1;
 INSERT INTO analytics_retention_accounts(account_id) SELECT NEW.account_id WHERE NEW.account_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE id=NEW.account_id) ON CONFLICT(account_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER retention_reversi_rating_changes_insert AFTER INSERT ON reversi_rating_changes BEGIN
 INSERT INTO analytics_retention_accounts(account_id) SELECT NEW.account_id WHERE NEW.account_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE id=NEW.account_id) ON CONFLICT(account_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER retention_reversi_rating_changes_delete AFTER DELETE ON reversi_rating_changes BEGIN
 INSERT INTO analytics_retention_accounts(account_id) SELECT OLD.account_id WHERE OLD.account_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE id=OLD.account_id) ON CONFLICT(account_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER retention_reversi_rating_changes_update AFTER UPDATE ON reversi_rating_changes BEGIN
 INSERT INTO analytics_retention_accounts(account_id) SELECT OLD.account_id WHERE OLD.account_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE id=OLD.account_id) ON CONFLICT(account_id) DO UPDATE SET revision=revision+1;
 INSERT INTO analytics_retention_accounts(account_id) SELECT NEW.account_id WHERE NEW.account_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE id=NEW.account_id) ON CONFLICT(account_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER retention_four_shogi_rating_changes_insert AFTER INSERT ON four_shogi_rating_changes BEGIN
 INSERT INTO analytics_retention_accounts(account_id) SELECT NEW.account_id WHERE NEW.account_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE id=NEW.account_id) ON CONFLICT(account_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER retention_four_shogi_rating_changes_delete AFTER DELETE ON four_shogi_rating_changes BEGIN
 INSERT INTO analytics_retention_accounts(account_id) SELECT OLD.account_id WHERE OLD.account_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE id=OLD.account_id) ON CONFLICT(account_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER retention_four_shogi_rating_changes_update AFTER UPDATE ON four_shogi_rating_changes BEGIN
 INSERT INTO analytics_retention_accounts(account_id) SELECT OLD.account_id WHERE OLD.account_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE id=OLD.account_id) ON CONFLICT(account_id) DO UPDATE SET revision=revision+1;
 INSERT INTO analytics_retention_accounts(account_id) SELECT NEW.account_id WHERE NEW.account_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE id=NEW.account_id) ON CONFLICT(account_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER retention_four_reversi_rating_changes_insert AFTER INSERT ON four_reversi_rating_changes BEGIN
 INSERT INTO analytics_retention_accounts(account_id) SELECT NEW.account_id WHERE NEW.account_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE id=NEW.account_id) ON CONFLICT(account_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER retention_four_reversi_rating_changes_delete AFTER DELETE ON four_reversi_rating_changes BEGIN
 INSERT INTO analytics_retention_accounts(account_id) SELECT OLD.account_id WHERE OLD.account_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE id=OLD.account_id) ON CONFLICT(account_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER retention_four_reversi_rating_changes_update AFTER UPDATE ON four_reversi_rating_changes BEGIN
 INSERT INTO analytics_retention_accounts(account_id) SELECT OLD.account_id WHERE OLD.account_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE id=OLD.account_id) ON CONFLICT(account_id) DO UPDATE SET revision=revision+1;
 INSERT INTO analytics_retention_accounts(account_id) SELECT NEW.account_id WHERE NEW.account_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE id=NEW.account_id) ON CONFLICT(account_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER retention_matches_update AFTER UPDATE ON matches BEGIN
 INSERT INTO analytics_retention_accounts(account_id)
 SELECT DISTINCT origin_account_id FROM analytics_participants WHERE match_id=NEW.id AND origin_account_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE id=origin_account_id)
 ON CONFLICT(account_id) DO UPDATE SET revision=revision+1;
 END;
CREATE TRIGGER retention_analytics_matches_update AFTER UPDATE ON analytics_matches BEGIN
 INSERT INTO analytics_retention_accounts(account_id)
 SELECT DISTINCT origin_account_id FROM analytics_participants WHERE match_id=NEW.id AND origin_account_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE id=origin_account_id)
 ON CONFLICT(account_id) DO UPDATE SET revision=revision+1;
 END;
CREATE TRIGGER retention_subject_insert_fence BEFORE INSERT ON analytics_retention_subjects
WHEN EXISTS(SELECT 1 FROM deleted_accounts WHERE id=NEW.account_id) BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER retention_subject_update_fence BEFORE UPDATE ON analytics_retention_subjects
WHEN EXISTS(SELECT 1 FROM deleted_accounts WHERE id=NEW.account_id) BEGIN SELECT RAISE(IGNORE); END;
