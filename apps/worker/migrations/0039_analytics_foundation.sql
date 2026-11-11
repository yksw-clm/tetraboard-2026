-- 統合先へ認証・ゲーム履歴を移しても、分析上の起点の本人を遡って置換しません。
ALTER TABLE analytics_participants ADD COLUMN origin_account_id TEXT;
CREATE TRIGGER foundation_participant_origin AFTER INSERT ON analytics_participants
WHEN NEW.origin_account_id IS NULL AND NEW.account_id IS NOT NULL
  AND NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE id=NEW.account_id) BEGIN
  UPDATE analytics_participants SET origin_account_id=NEW.account_id WHERE match_id=NEW.match_id AND player_id=NEW.player_id;
END;
-- 最終値と棋譜由来の本人集計は退会まで。本人集計に新たな対局ID対応表は作りません。
CREATE TABLE account_usage (
  account_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  last_login_at_ms INTEGER,
  last_used_day TEXT
);
CREATE TABLE account_game_totals (
  account_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  game TEXT NOT NULL,
  completed INTEGER NOT NULL,
  first_completed_at_ms INTEGER NOT NULL,
  last_completed_at_ms INTEGER NOT NULL,
  PRIMARY KEY(account_id,game)
);
CREATE TABLE account_totals_dirty (account_id TEXT PRIMARY KEY);
CREATE TABLE analytics_foundation_state (
  id INTEGER PRIMARY KEY CHECK(id=1),
  collected_from_ms INTEGER NOT NULL,
  aggregated_at_ms INTEGER,
  metric_version INTEGER NOT NULL DEFAULT 1,
  backfill_cursor TEXT NOT NULL DEFAULT '',
  backfill_complete INTEGER NOT NULL DEFAULT 0
);
INSERT INTO analytics_foundation_state(id,collected_from_ms)
VALUES(1,CAST(unixepoch('subsec')*1000 AS INTEGER));
CREATE TABLE analytics_dirty_days (day TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 1);
-- 個人・ブラウザ・対局IDを持たない日次値。allは全ゲームの重複排除を独立して計算します。
CREATE TABLE analytics_daily_v2 (
  day TEXT NOT NULL, game TEXT NOT NULL, internal INTEGER NOT NULL,
  page_views INTEGER NOT NULL, visitors INTEGER NOT NULL, dwell_ms INTEGER NOT NULL,
  started INTEGER NOT NULL, completed INTEGER NOT NULL, abandoned INTEGER NOT NULL,
  cpu_matches INTEGER NOT NULL, human_matches INTEGER NOT NULL, completed_duration_ms INTEGER NOT NULL,
  registered_active INTEGER NOT NULL, guest_active INTEGER NOT NULL,
  incomplete INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(day,game,internal)
);
CREATE TRIGGER usage_insert_fence BEFORE INSERT ON account_usage
WHEN EXISTS(SELECT 1 FROM deleted_accounts WHERE id=NEW.account_id)
  OR EXISTS(SELECT 1 FROM guest_account_merges WHERE guest_id=NEW.account_id)
BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER usage_update_fence BEFORE UPDATE ON account_usage
WHEN EXISTS(SELECT 1 FROM deleted_accounts WHERE id=NEW.account_id)
  OR EXISTS(SELECT 1 FROM guest_account_merges WHERE guest_id=NEW.account_id)
BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER foundation_delete_account AFTER INSERT ON deleted_accounts BEGIN
  UPDATE analytics_participants SET origin_account_id=NULL WHERE origin_account_id=NEW.id;
  DELETE FROM account_usage WHERE account_id=NEW.id;
  DELETE FROM account_game_totals WHERE account_id=NEW.id;
  DELETE FROM account_totals_dirty WHERE account_id=NEW.id;
END;
CREATE TRIGGER foundation_merge_account AFTER INSERT ON guest_account_merges BEGIN
  DELETE FROM account_usage WHERE account_id=NEW.guest_id;
  DELETE FROM account_game_totals WHERE account_id=NEW.guest_id;
  DELETE FROM account_totals_dirty WHERE account_id=NEW.guest_id;
  INSERT OR IGNORE INTO account_totals_dirty VALUES(NEW.account_id);
END;
CREATE TRIGGER foundation_history_insert AFTER INSERT ON account_match_history BEGIN
  INSERT OR IGNORE INTO account_totals_dirty VALUES(NEW.account_id);
END;
CREATE TRIGGER foundation_history_delete AFTER DELETE ON account_match_history BEGIN
  INSERT OR IGNORE INTO account_totals_dirty VALUES(OLD.account_id);
END;
CREATE TRIGGER foundation_history_update AFTER UPDATE ON account_match_history BEGIN
  INSERT OR IGNORE INTO account_totals_dirty VALUES(OLD.account_id);
  INSERT OR IGNORE INTO account_totals_dirty VALUES(NEW.account_id);
END;
CREATE TRIGGER foundation_analytics_pageviews_insert AFTER INSERT ON analytics_pageviews BEGIN
  INSERT INTO analytics_dirty_days(day) SELECT strftime('%Y-%m-%d', NEW.started_at_ms/1000+32400,'unixepoch') WHERE strftime('%Y-%m-%d', NEW.started_at_ms/1000+32400,'unixepoch') IS NOT NULL
    ON CONFLICT(day) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER foundation_analytics_pageviews_delete AFTER DELETE ON analytics_pageviews BEGIN
  INSERT INTO analytics_dirty_days(day) SELECT strftime('%Y-%m-%d', OLD.started_at_ms/1000+32400,'unixepoch') WHERE strftime('%Y-%m-%d', OLD.started_at_ms/1000+32400,'unixepoch') IS NOT NULL
    ON CONFLICT(day) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER foundation_analytics_pageviews_update AFTER UPDATE ON analytics_pageviews WHEN OLD.account_id IS NOT NEW.account_id OR OLD.is_test IS NOT NEW.is_test OR OLD.game IS NOT NEW.game OR OLD.started_at_ms IS NOT NEW.started_at_ms BEGIN
  INSERT INTO analytics_dirty_days(day) SELECT strftime('%Y-%m-%d', OLD.started_at_ms/1000+32400,'unixepoch') WHERE strftime('%Y-%m-%d', OLD.started_at_ms/1000+32400,'unixepoch') IS NOT NULL
    ON CONFLICT(day) DO UPDATE SET revision=revision+1;
  INSERT INTO analytics_dirty_days(day) SELECT strftime('%Y-%m-%d', NEW.started_at_ms/1000+32400,'unixepoch') WHERE strftime('%Y-%m-%d', NEW.started_at_ms/1000+32400,'unixepoch') IS NOT NULL
    ON CONFLICT(day) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER foundation_analytics_dwell_insert AFTER INSERT ON analytics_dwell BEGIN
  INSERT INTO analytics_dirty_days(day) SELECT NEW.day WHERE NEW.day IS NOT NULL
    ON CONFLICT(day) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER foundation_analytics_dwell_delete AFTER DELETE ON analytics_dwell BEGIN
  INSERT INTO analytics_dirty_days(day) SELECT OLD.day WHERE OLD.day IS NOT NULL
    ON CONFLICT(day) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER foundation_analytics_dwell_update AFTER UPDATE ON analytics_dwell WHEN OLD.milliseconds IS NOT NEW.milliseconds OR OLD.day IS NOT NEW.day BEGIN
  INSERT INTO analytics_dirty_days(day) SELECT OLD.day WHERE OLD.day IS NOT NULL
    ON CONFLICT(day) DO UPDATE SET revision=revision+1;
  INSERT INTO analytics_dirty_days(day) SELECT NEW.day WHERE NEW.day IS NOT NULL
    ON CONFLICT(day) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER foundation_analytics_matches_insert AFTER INSERT ON analytics_matches BEGIN
  INSERT INTO analytics_dirty_days(day) SELECT strftime('%Y-%m-%d', NEW.started_at_ms/1000+32400,'unixepoch') WHERE strftime('%Y-%m-%d', NEW.started_at_ms/1000+32400,'unixepoch') IS NOT NULL
    ON CONFLICT(day) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER foundation_analytics_matches_delete AFTER DELETE ON analytics_matches BEGIN
  INSERT INTO analytics_dirty_days(day) SELECT strftime('%Y-%m-%d', OLD.started_at_ms/1000+32400,'unixepoch') WHERE strftime('%Y-%m-%d', OLD.started_at_ms/1000+32400,'unixepoch') IS NOT NULL
    ON CONFLICT(day) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER foundation_analytics_matches_update AFTER UPDATE ON analytics_matches WHEN OLD.status IS NOT NEW.status OR OLD.ended_at_ms IS NOT NEW.ended_at_ms BEGIN
  INSERT INTO analytics_dirty_days(day) SELECT strftime('%Y-%m-%d', OLD.started_at_ms/1000+32400,'unixepoch') WHERE strftime('%Y-%m-%d', OLD.started_at_ms/1000+32400,'unixepoch') IS NOT NULL
    ON CONFLICT(day) DO UPDATE SET revision=revision+1;
  INSERT INTO analytics_dirty_days(day) SELECT strftime('%Y-%m-%d', NEW.started_at_ms/1000+32400,'unixepoch') WHERE strftime('%Y-%m-%d', NEW.started_at_ms/1000+32400,'unixepoch') IS NOT NULL
    ON CONFLICT(day) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER foundation_analytics_participants_insert AFTER INSERT ON analytics_participants BEGIN
  INSERT INTO analytics_dirty_days(day) SELECT (SELECT strftime('%Y-%m-%d',started_at_ms/1000+32400,'unixepoch') FROM analytics_matches WHERE id=NEW.match_id) WHERE (SELECT strftime('%Y-%m-%d',started_at_ms/1000+32400,'unixepoch') FROM analytics_matches WHERE id=NEW.match_id) IS NOT NULL
    ON CONFLICT(day) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER foundation_analytics_participants_delete AFTER DELETE ON analytics_participants BEGIN
  INSERT INTO analytics_dirty_days(day) SELECT (SELECT strftime('%Y-%m-%d',started_at_ms/1000+32400,'unixepoch') FROM analytics_matches WHERE id=OLD.match_id) WHERE (SELECT strftime('%Y-%m-%d',started_at_ms/1000+32400,'unixepoch') FROM analytics_matches WHERE id=OLD.match_id) IS NOT NULL
    ON CONFLICT(day) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER foundation_analytics_participants_update AFTER UPDATE ON analytics_participants WHEN OLD.account_id IS NOT NEW.account_id OR OLD.is_test IS NOT NEW.is_test OR OLD.is_guest IS NOT NEW.is_guest OR OLD.origin_account_id IS NOT NEW.origin_account_id BEGIN
  INSERT INTO analytics_dirty_days(day) SELECT (SELECT strftime('%Y-%m-%d',started_at_ms/1000+32400,'unixepoch') FROM analytics_matches WHERE id=OLD.match_id) WHERE (SELECT strftime('%Y-%m-%d',started_at_ms/1000+32400,'unixepoch') FROM analytics_matches WHERE id=OLD.match_id) IS NOT NULL
    ON CONFLICT(day) DO UPDATE SET revision=revision+1;
  INSERT INTO analytics_dirty_days(day) SELECT (SELECT strftime('%Y-%m-%d',started_at_ms/1000+32400,'unixepoch') FROM analytics_matches WHERE id=NEW.match_id) WHERE (SELECT strftime('%Y-%m-%d',started_at_ms/1000+32400,'unixepoch') FROM analytics_matches WHERE id=NEW.match_id) IS NOT NULL
    ON CONFLICT(day) DO UPDATE SET revision=revision+1;
END;

CREATE TABLE analytics_foundation_archive (
  day TEXT NOT NULL, game TEXT NOT NULL, internal INTEGER NOT NULL,
  page_views INTEGER NOT NULL DEFAULT 0, dwell_ms INTEGER NOT NULL DEFAULT 0,
  started INTEGER NOT NULL DEFAULT 0, completed INTEGER NOT NULL DEFAULT 0, abandoned INTEGER NOT NULL DEFAULT 0,
  cpu_matches INTEGER NOT NULL DEFAULT 0, human_matches INTEGER NOT NULL DEFAULT 0,
  completed_duration_ms INTEGER NOT NULL DEFAULT 0,
  incomplete INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(day,game,internal)
);

CREATE INDEX analytics_participants_origin_account ON analytics_participants(origin_account_id);
CREATE TRIGGER foundation_origin_privacy_insert AFTER INSERT ON analytics_participants
WHEN EXISTS(SELECT 1 FROM deleted_accounts WHERE id=NEW.origin_account_id) BEGIN
  UPDATE analytics_participants SET origin_account_id=NULL WHERE match_id=NEW.match_id AND player_id=NEW.player_id;
END;
CREATE TRIGGER foundation_origin_privacy_update AFTER UPDATE OF origin_account_id ON analytics_participants
WHEN EXISTS(SELECT 1 FROM deleted_accounts WHERE id=NEW.origin_account_id) BEGIN
  UPDATE analytics_participants SET origin_account_id=NULL WHERE match_id=NEW.match_id AND player_id=NEW.player_id;
END;
