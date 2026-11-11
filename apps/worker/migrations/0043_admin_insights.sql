-- 本人履歴由来の期間内局数。個別の対局対応表は追加しません。
CREATE TABLE account_game_daily (
  account_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  day TEXT NOT NULL, game TEXT NOT NULL, completed INTEGER NOT NULL,
  PRIMARY KEY(account_id,day,game)
);
CREATE TRIGGER insights_delete_account AFTER INSERT ON deleted_accounts BEGIN
  DELETE FROM account_game_daily WHERE account_id=NEW.id;
END;
CREATE TRIGGER insights_merge_account AFTER INSERT ON guest_account_merges BEGIN
  DELETE FROM account_game_daily WHERE account_id=NEW.guest_id;
END;
-- 既存の通算値も次の差分バッチで期間値とそろえます。
INSERT OR IGNORE INTO account_totals_dirty SELECT id FROM user;

CREATE TABLE analytics_acquisition_snapshot (
 day TEXT NOT NULL,game TEXT NOT NULL,internal INTEGER NOT NULL,dimension TEXT NOT NULL,
 value TEXT NOT NULL,medium TEXT NOT NULL,campaign TEXT NOT NULL,visits INTEGER NOT NULL,started INTEGER NOT NULL,
 PRIMARY KEY(day,game,internal,dimension,value,medium,campaign)
);
CREATE TABLE analytics_acquisition_dirty_days(day TEXT PRIMARY KEY,revision INTEGER NOT NULL DEFAULT 1);
CREATE INDEX acquisition_visit_day ON analytics_session_visits(started_at_ms);
INSERT INTO analytics_acquisition_dirty_days(day)
 SELECT DISTINCT day FROM (
 SELECT strftime('%Y-%m-%d',started_at_ms/1000+32400,'unixepoch') AS day FROM analytics_session_visits
 UNION SELECT strftime('%Y-%m-%d',started_at_ms/1000+32400,'unixepoch') FROM analytics_matches
 UNION SELECT day FROM analytics_acquisition_daily) WHERE day IS NOT NULL;
CREATE TRIGGER insights_analytics_session_visits_insert AFTER INSERT ON analytics_session_visits BEGIN
 INSERT INTO analytics_acquisition_dirty_days(day) SELECT strftime('%Y-%m-%d',NEW.started_at_ms/1000+32400,'unixepoch') WHERE strftime('%Y-%m-%d',NEW.started_at_ms/1000+32400,'unixepoch') IS NOT NULL ON CONFLICT(day) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER insights_analytics_session_visits_delete AFTER DELETE ON analytics_session_visits BEGIN
 INSERT INTO analytics_acquisition_dirty_days(day) SELECT strftime('%Y-%m-%d',OLD.started_at_ms/1000+32400,'unixepoch') WHERE strftime('%Y-%m-%d',OLD.started_at_ms/1000+32400,'unixepoch') IS NOT NULL ON CONFLICT(day) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER insights_analytics_session_visits_update AFTER UPDATE ON analytics_session_visits BEGIN
 INSERT INTO analytics_acquisition_dirty_days(day) SELECT strftime('%Y-%m-%d',OLD.started_at_ms/1000+32400,'unixepoch') WHERE strftime('%Y-%m-%d',OLD.started_at_ms/1000+32400,'unixepoch') IS NOT NULL ON CONFLICT(day) DO UPDATE SET revision=revision+1;
 INSERT INTO analytics_acquisition_dirty_days(day) SELECT strftime('%Y-%m-%d',NEW.started_at_ms/1000+32400,'unixepoch') WHERE strftime('%Y-%m-%d',NEW.started_at_ms/1000+32400,'unixepoch') IS NOT NULL ON CONFLICT(day) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER insights_analytics_matches_insert AFTER INSERT ON analytics_matches BEGIN
 INSERT INTO analytics_acquisition_dirty_days(day) SELECT strftime('%Y-%m-%d',NEW.started_at_ms/1000+32400,'unixepoch') WHERE strftime('%Y-%m-%d',NEW.started_at_ms/1000+32400,'unixepoch') IS NOT NULL ON CONFLICT(day) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER insights_analytics_matches_delete AFTER DELETE ON analytics_matches BEGIN
 INSERT INTO analytics_acquisition_dirty_days(day) SELECT strftime('%Y-%m-%d',OLD.started_at_ms/1000+32400,'unixepoch') WHERE strftime('%Y-%m-%d',OLD.started_at_ms/1000+32400,'unixepoch') IS NOT NULL ON CONFLICT(day) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER insights_analytics_matches_update AFTER UPDATE ON analytics_matches BEGIN
 INSERT INTO analytics_acquisition_dirty_days(day) SELECT strftime('%Y-%m-%d',OLD.started_at_ms/1000+32400,'unixepoch') WHERE strftime('%Y-%m-%d',OLD.started_at_ms/1000+32400,'unixepoch') IS NOT NULL ON CONFLICT(day) DO UPDATE SET revision=revision+1;
 INSERT INTO analytics_acquisition_dirty_days(day) SELECT strftime('%Y-%m-%d',NEW.started_at_ms/1000+32400,'unixepoch') WHERE strftime('%Y-%m-%d',NEW.started_at_ms/1000+32400,'unixepoch') IS NOT NULL ON CONFLICT(day) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER insights_analytics_participants_insert AFTER INSERT ON analytics_participants BEGIN
 INSERT INTO analytics_acquisition_dirty_days(day) SELECT (SELECT strftime('%Y-%m-%d',started_at_ms/1000+32400,'unixepoch') FROM analytics_matches WHERE id=NEW.match_id) WHERE (SELECT strftime('%Y-%m-%d',started_at_ms/1000+32400,'unixepoch') FROM analytics_matches WHERE id=NEW.match_id) IS NOT NULL ON CONFLICT(day) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER insights_analytics_participants_delete AFTER DELETE ON analytics_participants BEGIN
 INSERT INTO analytics_acquisition_dirty_days(day) SELECT (SELECT strftime('%Y-%m-%d',started_at_ms/1000+32400,'unixepoch') FROM analytics_matches WHERE id=OLD.match_id) WHERE (SELECT strftime('%Y-%m-%d',started_at_ms/1000+32400,'unixepoch') FROM analytics_matches WHERE id=OLD.match_id) IS NOT NULL ON CONFLICT(day) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER insights_analytics_participants_update AFTER UPDATE ON analytics_participants BEGIN
 INSERT INTO analytics_acquisition_dirty_days(day) SELECT (SELECT strftime('%Y-%m-%d',started_at_ms/1000+32400,'unixepoch') FROM analytics_matches WHERE id=OLD.match_id) WHERE (SELECT strftime('%Y-%m-%d',started_at_ms/1000+32400,'unixepoch') FROM analytics_matches WHERE id=OLD.match_id) IS NOT NULL ON CONFLICT(day) DO UPDATE SET revision=revision+1;
 INSERT INTO analytics_acquisition_dirty_days(day) SELECT (SELECT strftime('%Y-%m-%d',started_at_ms/1000+32400,'unixepoch') FROM analytics_matches WHERE id=NEW.match_id) WHERE (SELECT strftime('%Y-%m-%d',started_at_ms/1000+32400,'unixepoch') FROM analytics_matches WHERE id=NEW.match_id) IS NOT NULL ON CONFLICT(day) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER insights_session_update AFTER UPDATE ON analytics_sessions
WHEN OLD.account_id IS NOT NEW.account_id OR OLD.referrer_host IS NOT NEW.referrer_host BEGIN
 INSERT INTO analytics_acquisition_dirty_days(day)
 SELECT DISTINCT strftime('%Y-%m-%d',started_at_ms/1000+32400,'unixepoch') FROM analytics_session_visits WHERE session_id=NEW.id
 ON CONFLICT(day) DO UPDATE SET revision=revision+1;
END;

CREATE TABLE account_insights_ready(account_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE);
CREATE TRIGGER insights_ready_delete AFTER INSERT ON deleted_accounts BEGIN DELETE FROM account_insights_ready WHERE account_id=NEW.id; END;
CREATE TRIGGER insights_ready_merge AFTER INSERT ON guest_account_merges BEGIN DELETE FROM account_insights_ready WHERE account_id=NEW.guest_id; END;

CREATE INDEX account_game_daily_period ON account_game_daily(day,game,account_id);
