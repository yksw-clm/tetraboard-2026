-- 番号は再利用せず、帰属の意味は発行時に固定します。
CREATE TABLE analytics_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL, medium TEXT NOT NULL, campaign TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0, created_at_ms INTEGER NOT NULL
);
INSERT INTO analytics_links(id,label,medium,campaign,created_at_ms) VALUES
  (1,'開発者Xプロフィール','social','profile',CAST(unixepoch('subsec')*1000 AS INTEGER)),
  (2,'TetraBoard公式Xプロフィール','social','profile',CAST(unixepoch('subsec')*1000 AS INTEGER)),
  (3,'開発者X投稿','social','post',CAST(unixepoch('subsec')*1000 AS INTEGER)),
  (4,'TetraBoard公式X投稿','social','post',CAST(unixepoch('subsec')*1000 AS INTEGER));
ALTER TABLE analytics_sessions ADD COLUMN utm_link_id INTEGER;
ALTER TABLE analytics_participants ADD COLUMN utm_link_id INTEGER;

-- 入口ごとの短い手続きIDで関連付け、端末を識別するCookieは増やしません。
CREATE TABLE analytics_registration_flows (
  id TEXT PRIMARY KEY, created_at_ms INTEGER NOT NULL,
  visitor_id TEXT, source_account_id TEXT, target_account_id TEXT,
  is_new_registration INTEGER, profile_required INTEGER,
  kind TEXT NOT NULL, is_test INTEGER NOT NULL DEFAULT 0,
  entry TEXT NOT NULL, game TEXT NOT NULL,
  session_id TEXT, utm_link_id INTEGER,
  utm_source TEXT, utm_medium TEXT, utm_campaign TEXT,
  referrer_class TEXT, device TEXT
);
CREATE INDEX analytics_registration_flows_period ON analytics_registration_flows(created_at_ms);
CREATE INDEX analytics_registration_flows_visitor ON analytics_registration_flows(visitor_id,created_at_ms);
CREATE INDEX analytics_registration_flows_source ON analytics_registration_flows(source_account_id);
CREATE INDEX analytics_registration_flows_target ON analytics_registration_flows(target_account_id);
CREATE TABLE analytics_registration_deleted_flows(id TEXT PRIMARY KEY,expires_at_ms INTEGER NOT NULL);
CREATE INDEX analytics_registration_deleted_flows_expiry ON analytics_registration_deleted_flows(expires_at_ms);
CREATE TABLE analytics_registration_events (
  flow_id TEXT NOT NULL REFERENCES analytics_registration_flows(id) ON DELETE CASCADE,
  stage TEXT NOT NULL, occurred_at_ms INTEGER NOT NULL,
  PRIMARY KEY(flow_id,stage)
);
CREATE TABLE analytics_registration_attempts (
  state_hash TEXT PRIMARY KEY, flow_id TEXT NOT NULL REFERENCES analytics_registration_flows(id) ON DELETE CASCADE,
  provider TEXT NOT NULL, started_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL
);
CREATE INDEX analytics_registration_attempts_expiry ON analytics_registration_attempts(expires_at_ms);
CREATE TABLE analytics_registration_dirty_days(day TEXT PRIMARY KEY,revision INTEGER NOT NULL DEFAULT 1);
CREATE TABLE analytics_registration_daily (
  entry_day TEXT NOT NULL, day TEXT NOT NULL, entry TEXT NOT NULL, game TEXT NOT NULL, kind TEXT NOT NULL,
  internal INTEGER NOT NULL, stage TEXT NOT NULL, utm_link_id INTEGER NOT NULL,
  source TEXT NOT NULL, medium TEXT NOT NULL, campaign TEXT NOT NULL,
  referrer_class TEXT NOT NULL, device TEXT NOT NULL, count INTEGER NOT NULL,
  PRIMARY KEY(entry_day,day,entry,game,kind,internal,stage,utm_link_id,source,medium,campaign,referrer_class,device)
);
CREATE INDEX analytics_registration_daily_event_day ON analytics_registration_daily(day);
CREATE TABLE analytics_registration_archive AS SELECT * FROM analytics_registration_daily WHERE 0;
CREATE UNIQUE INDEX analytics_registration_archive_key ON analytics_registration_archive
  (entry_day,day,entry,game,kind,internal,stage,utm_link_id,source,medium,campaign,referrer_class,device);
INSERT INTO analytics_metadata(key,value) VALUES('registration_collected_from',CAST(unixepoch('subsec')*1000 AS INTEGER));

CREATE TRIGGER privacy_registration_flow_insert BEFORE INSERT ON analytics_registration_flows
WHEN EXISTS(SELECT 1 FROM deleted_accounts WHERE id IN(NEW.source_account_id,NEW.target_account_id))
  OR EXISTS(SELECT 1 FROM analytics_registration_deleted_flows WHERE id=NEW.id AND expires_at_ms>NEW.created_at_ms)
BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER privacy_registration_flow_update BEFORE UPDATE ON analytics_registration_flows
WHEN EXISTS(SELECT 1 FROM deleted_accounts WHERE id IN(NEW.source_account_id,NEW.target_account_id))
BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER privacy_registration_delete AFTER INSERT ON deleted_accounts BEGIN
  INSERT OR IGNORE INTO analytics_registration_deleted_flows SELECT id,created_at_ms+7776000000 FROM analytics_registration_flows WHERE source_account_id=NEW.id OR target_account_id=NEW.id;
  DELETE FROM analytics_registration_flows WHERE source_account_id=NEW.id OR target_account_id=NEW.id;
END;
-- 新規連携で一時ユーザーを元ゲストに置き換える場合だけ、同じ登録手続きを維持します。
CREATE TRIGGER analytics_registration_promotion AFTER INSERT ON guest_promotions BEGIN
  UPDATE analytics_registration_flows SET target_account_id=NEW.guest_id WHERE target_account_id=NEW.temporary_id;
END;
CREATE TRIGGER analytics_registration_flows_insert AFTER INSERT ON analytics_registration_flows BEGIN
  INSERT INTO analytics_registration_dirty_days(day) SELECT strftime('%Y-%m-%d',NEW.created_at_ms/1000+32400,'unixepoch') WHERE strftime('%Y-%m-%d',NEW.created_at_ms/1000+32400,'unixepoch') IS NOT NULL ON CONFLICT(day) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER analytics_registration_flows_update AFTER UPDATE ON analytics_registration_flows BEGIN
  INSERT INTO analytics_registration_dirty_days(day) SELECT strftime('%Y-%m-%d',OLD.created_at_ms/1000+32400,'unixepoch') WHERE strftime('%Y-%m-%d',OLD.created_at_ms/1000+32400,'unixepoch') IS NOT NULL ON CONFLICT(day) DO UPDATE SET revision=revision+1;
  INSERT INTO analytics_registration_dirty_days(day) SELECT strftime('%Y-%m-%d',NEW.created_at_ms/1000+32400,'unixepoch') WHERE strftime('%Y-%m-%d',NEW.created_at_ms/1000+32400,'unixepoch') IS NOT NULL ON CONFLICT(day) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER analytics_registration_flows_delete AFTER DELETE ON analytics_registration_flows BEGIN
  INSERT INTO analytics_registration_dirty_days(day) SELECT strftime('%Y-%m-%d',OLD.created_at_ms/1000+32400,'unixepoch') WHERE strftime('%Y-%m-%d',OLD.created_at_ms/1000+32400,'unixepoch') IS NOT NULL ON CONFLICT(day) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER analytics_registration_events_insert AFTER INSERT ON analytics_registration_events BEGIN
  INSERT INTO analytics_registration_dirty_days(day) SELECT (SELECT strftime('%Y-%m-%d',created_at_ms/1000+32400,'unixepoch') FROM analytics_registration_flows WHERE id=NEW.flow_id) WHERE (SELECT strftime('%Y-%m-%d',created_at_ms/1000+32400,'unixepoch') FROM analytics_registration_flows WHERE id=NEW.flow_id) IS NOT NULL ON CONFLICT(day) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER analytics_registration_events_update AFTER UPDATE ON analytics_registration_events BEGIN
  INSERT INTO analytics_registration_dirty_days(day) SELECT (SELECT strftime('%Y-%m-%d',created_at_ms/1000+32400,'unixepoch') FROM analytics_registration_flows WHERE id=OLD.flow_id) WHERE (SELECT strftime('%Y-%m-%d',created_at_ms/1000+32400,'unixepoch') FROM analytics_registration_flows WHERE id=OLD.flow_id) IS NOT NULL ON CONFLICT(day) DO UPDATE SET revision=revision+1;
  INSERT INTO analytics_registration_dirty_days(day) SELECT (SELECT strftime('%Y-%m-%d',created_at_ms/1000+32400,'unixepoch') FROM analytics_registration_flows WHERE id=NEW.flow_id) WHERE (SELECT strftime('%Y-%m-%d',created_at_ms/1000+32400,'unixepoch') FROM analytics_registration_flows WHERE id=NEW.flow_id) IS NOT NULL ON CONFLICT(day) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER analytics_registration_events_delete AFTER DELETE ON analytics_registration_events BEGIN
  INSERT INTO analytics_registration_dirty_days(day) SELECT (SELECT strftime('%Y-%m-%d',created_at_ms/1000+32400,'unixepoch') FROM analytics_registration_flows WHERE id=OLD.flow_id) WHERE (SELECT strftime('%Y-%m-%d',created_at_ms/1000+32400,'unixepoch') FROM analytics_registration_flows WHERE id=OLD.flow_id) IS NOT NULL ON CONFLICT(day) DO UPDATE SET revision=revision+1;
END;
