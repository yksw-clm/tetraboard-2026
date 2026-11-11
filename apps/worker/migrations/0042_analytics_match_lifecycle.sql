-- 新しい対局計測だけを対象とし、過去の種別や終了理由は推測しません。
ALTER TABLE analytics_matches ADD COLUMN match_kind TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE analytics_matches ADD COLUMN human_count INTEGER;
ALTER TABLE analytics_matches ADD COLUMN end_reason TEXT;
ALTER TABLE analytics_participants ADD COLUMN end_reason TEXT;
CREATE TABLE analytics_matchmaking_events (
 id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, account_id TEXT NOT NULL,
 match_id TEXT, game TEXT NOT NULL, stage TEXT NOT NULL, reason TEXT,
 at_ms INTEGER NOT NULL, waiting_ms INTEGER, humans INTEGER, rated INTEGER NOT NULL,
 is_test INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX analytics_matchmaking_events_time ON analytics_matchmaking_events(at_ms);
CREATE INDEX analytics_matchmaking_events_account ON analytics_matchmaking_events(account_id);
CREATE INDEX analytics_matchmaking_events_operation ON analytics_matchmaking_events(operation_id,account_id);
CREATE INDEX analytics_matches_lifecycle_time ON analytics_matches(started_at_ms) WHERE match_kind!='unknown';
CREATE TABLE analytics_lifecycle_dirty_days(day TEXT PRIMARY KEY,revision INTEGER NOT NULL DEFAULT 1);
CREATE TABLE analytics_lifecycle_daily (
 day TEXT NOT NULL,game TEXT NOT NULL,internal INTEGER NOT NULL,
 scope TEXT NOT NULL,kind TEXT NOT NULL,reason TEXT NOT NULL,humans INTEGER NOT NULL,
 count INTEGER NOT NULL,waiting_ms INTEGER NOT NULL,waiting_samples INTEGER NOT NULL,
 PRIMARY KEY(day,game,internal,scope,kind,reason,humans)
);
CREATE TABLE analytics_lifecycle_archive AS SELECT * FROM analytics_lifecycle_daily WHERE 0;
CREATE UNIQUE INDEX analytics_lifecycle_archive_key ON analytics_lifecycle_archive(day,game,internal,scope,kind,reason,humans);
INSERT INTO analytics_metadata(key,value) VALUES('lifecycle_collected_from',CAST(unixepoch('subsec')*1000 AS INTEGER));
CREATE TRIGGER privacy_matchmaking_event_insert BEFORE INSERT ON analytics_matchmaking_events
WHEN EXISTS(SELECT 1 FROM deleted_accounts WHERE id=NEW.account_id)
BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER privacy_matchmaking_event_delete AFTER INSERT ON deleted_accounts BEGIN
 DELETE FROM analytics_matchmaking_events WHERE account_id=NEW.id;
END;
CREATE TRIGGER lifecycle_queue_insert AFTER INSERT ON analytics_matchmaking_events BEGIN
 INSERT INTO analytics_lifecycle_dirty_days(day) SELECT strftime('%Y-%m-%d',NEW.at_ms/1000+32400,'unixepoch') WHERE strftime('%Y-%m-%d',NEW.at_ms/1000+32400,'unixepoch') IS NOT NULL ON CONFLICT(day) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER lifecycle_queue_delete AFTER DELETE ON analytics_matchmaking_events BEGIN
 INSERT INTO analytics_lifecycle_dirty_days(day) SELECT strftime('%Y-%m-%d',OLD.at_ms/1000+32400,'unixepoch') WHERE strftime('%Y-%m-%d',OLD.at_ms/1000+32400,'unixepoch') IS NOT NULL ON CONFLICT(day) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER lifecycle_match_insert AFTER INSERT ON analytics_matches WHEN NEW.match_kind!='unknown' BEGIN
 INSERT INTO analytics_lifecycle_dirty_days(day) SELECT strftime('%Y-%m-%d',NEW.started_at_ms/1000+32400,'unixepoch') WHERE strftime('%Y-%m-%d',NEW.started_at_ms/1000+32400,'unixepoch') IS NOT NULL ON CONFLICT(day) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER lifecycle_match_update AFTER UPDATE ON analytics_matches WHEN NEW.match_kind!='unknown' BEGIN
 INSERT INTO analytics_lifecycle_dirty_days(day) SELECT strftime('%Y-%m-%d',NEW.started_at_ms/1000+32400,'unixepoch') WHERE strftime('%Y-%m-%d',NEW.started_at_ms/1000+32400,'unixepoch') IS NOT NULL ON CONFLICT(day) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER lifecycle_match_delete AFTER DELETE ON analytics_matches WHEN OLD.match_kind!='unknown' BEGIN
 INSERT INTO analytics_lifecycle_dirty_days(day) SELECT strftime('%Y-%m-%d',OLD.started_at_ms/1000+32400,'unixepoch') WHERE strftime('%Y-%m-%d',OLD.started_at_ms/1000+32400,'unixepoch') IS NOT NULL ON CONFLICT(day) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER lifecycle_participant_insert AFTER INSERT ON analytics_participants BEGIN
 INSERT INTO analytics_lifecycle_dirty_days(day) SELECT (SELECT strftime('%Y-%m-%d',started_at_ms/1000+32400,'unixepoch') FROM analytics_matches WHERE id=NEW.match_id AND match_kind!='unknown') WHERE (SELECT strftime('%Y-%m-%d',started_at_ms/1000+32400,'unixepoch') FROM analytics_matches WHERE id=NEW.match_id AND match_kind!='unknown') IS NOT NULL ON CONFLICT(day) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER lifecycle_participant_update AFTER UPDATE ON analytics_participants BEGIN
 INSERT INTO analytics_lifecycle_dirty_days(day) SELECT (SELECT strftime('%Y-%m-%d',started_at_ms/1000+32400,'unixepoch') FROM analytics_matches WHERE id=NEW.match_id AND match_kind!='unknown') WHERE (SELECT strftime('%Y-%m-%d',started_at_ms/1000+32400,'unixepoch') FROM analytics_matches WHERE id=NEW.match_id AND match_kind!='unknown') IS NOT NULL ON CONFLICT(day) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER lifecycle_participant_delete AFTER DELETE ON analytics_participants BEGIN
 INSERT INTO analytics_lifecycle_dirty_days(day) SELECT (SELECT strftime('%Y-%m-%d',started_at_ms/1000+32400,'unixepoch') FROM analytics_matches WHERE id=OLD.match_id AND match_kind!='unknown') WHERE (SELECT strftime('%Y-%m-%d',started_at_ms/1000+32400,'unixepoch') FROM analytics_matches WHERE id=OLD.match_id AND match_kind!='unknown') IS NOT NULL ON CONFLICT(day) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER lifecycle_rating_matches AFTER INSERT ON matches BEGIN
 INSERT INTO analytics_lifecycle_dirty_days(day) SELECT (SELECT strftime('%Y-%m-%d',started_at_ms/1000+32400,'unixepoch') FROM analytics_matches WHERE id=NEW.id AND match_kind='rated') WHERE (SELECT strftime('%Y-%m-%d',started_at_ms/1000+32400,'unixepoch') FROM analytics_matches WHERE id=NEW.id AND match_kind='rated') IS NOT NULL ON CONFLICT(day) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER lifecycle_rating_shogi_rating_pending AFTER DELETE ON shogi_rating_pending BEGIN
 INSERT INTO analytics_lifecycle_dirty_days(day) SELECT (SELECT strftime('%Y-%m-%d',started_at_ms/1000+32400,'unixepoch') FROM analytics_matches WHERE id=OLD.match_id AND match_kind='rated') WHERE (SELECT strftime('%Y-%m-%d',started_at_ms/1000+32400,'unixepoch') FROM analytics_matches WHERE id=OLD.match_id AND match_kind='rated') IS NOT NULL ON CONFLICT(day) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER lifecycle_rating_reversi_rating_pending AFTER DELETE ON reversi_rating_pending BEGIN
 INSERT INTO analytics_lifecycle_dirty_days(day) SELECT (SELECT strftime('%Y-%m-%d',started_at_ms/1000+32400,'unixepoch') FROM analytics_matches WHERE id=OLD.match_id AND match_kind='rated') WHERE (SELECT strftime('%Y-%m-%d',started_at_ms/1000+32400,'unixepoch') FROM analytics_matches WHERE id=OLD.match_id AND match_kind='rated') IS NOT NULL ON CONFLICT(day) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER lifecycle_rating_four_reversi_rating_pending AFTER DELETE ON four_reversi_rating_pending BEGIN
 INSERT INTO analytics_lifecycle_dirty_days(day) SELECT (SELECT strftime('%Y-%m-%d',started_at_ms/1000+32400,'unixepoch') FROM analytics_matches WHERE id=OLD.match_id AND match_kind='rated') WHERE (SELECT strftime('%Y-%m-%d',started_at_ms/1000+32400,'unixepoch') FROM analytics_matches WHERE id=OLD.match_id AND match_kind='rated') IS NOT NULL ON CONFLICT(day) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER lifecycle_rating_four_shogi_rating_pending AFTER DELETE ON four_shogi_rating_pending BEGIN
 INSERT INTO analytics_lifecycle_dirty_days(day) SELECT (SELECT strftime('%Y-%m-%d',started_at_ms/1000+32400,'unixepoch') FROM analytics_matches WHERE id=OLD.match_id AND match_kind='rated') WHERE (SELECT strftime('%Y-%m-%d',started_at_ms/1000+32400,'unixepoch') FROM analytics_matches WHERE id=OLD.match_id AND match_kind='rated') IS NOT NULL ON CONFLICT(day) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER lifecycle_rating_shogi_changes AFTER INSERT ON shogi_rating_changes BEGIN
 INSERT INTO analytics_lifecycle_dirty_days(day) SELECT strftime('%Y-%m-%d',started_at_ms/1000+32400,'unixepoch') FROM analytics_matches WHERE id=NEW.match_id AND match_kind='rated'
 ON CONFLICT(day) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER lifecycle_rating_reversi_changes AFTER INSERT ON reversi_rating_changes BEGIN
 INSERT INTO analytics_lifecycle_dirty_days(day) SELECT strftime('%Y-%m-%d',started_at_ms/1000+32400,'unixepoch') FROM analytics_matches WHERE id=NEW.match_id AND match_kind='rated'
 ON CONFLICT(day) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER lifecycle_rating_four_reversi_changes AFTER INSERT ON four_reversi_rating_changes BEGIN
 INSERT INTO analytics_lifecycle_dirty_days(day) SELECT strftime('%Y-%m-%d',started_at_ms/1000+32400,'unixepoch') FROM analytics_matches WHERE id=NEW.match_id AND match_kind='rated'
 ON CONFLICT(day) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER lifecycle_rating_four_shogi_changes AFTER INSERT ON four_shogi_rating_changes BEGIN
 INSERT INTO analytics_lifecycle_dirty_days(day) SELECT strftime('%Y-%m-%d',started_at_ms/1000+32400,'unixepoch') FROM analytics_matches WHERE id=NEW.match_id AND match_kind='rated'
 ON CONFLICT(day) DO UPDATE SET revision=revision+1;
END;
