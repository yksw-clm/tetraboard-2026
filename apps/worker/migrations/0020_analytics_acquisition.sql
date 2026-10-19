-- ブラウザ内の識別子を増やさず、最初の閲覧IDを訪問のキーとして使います。
CREATE TABLE analytics_sessions (
  id TEXT PRIMARY KEY, visitor_id TEXT NOT NULL, account_id TEXT,
  started_at_ms INTEGER NOT NULL, last_activity_ms INTEGER NOT NULL,
  referrer_host TEXT, referrer_class TEXT, utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, device TEXT
);
CREATE INDEX analytics_sessions_visitor ON analytics_sessions(visitor_id, started_at_ms DESC);
CREATE INDEX analytics_sessions_retention ON analytics_sessions(started_at_ms);
CREATE TABLE analytics_session_visits (
  session_id TEXT NOT NULL REFERENCES analytics_sessions(id) ON DELETE CASCADE,
  game TEXT NOT NULL, started_at_ms INTEGER NOT NULL, account_id TEXT, is_test INTEGER NOT NULL,
  PRIMARY KEY(session_id, game)
);
ALTER TABLE analytics_pageviews ADD COLUMN session_id TEXT;
ALTER TABLE analytics_participants ADD COLUMN session_id TEXT;
ALTER TABLE analytics_participants ADD COLUMN referrer_class TEXT;
ALTER TABLE analytics_participants ADD COLUMN utm_source TEXT;
ALTER TABLE analytics_participants ADD COLUMN utm_medium TEXT;
ALTER TABLE analytics_participants ADD COLUMN utm_campaign TEXT;
ALTER TABLE analytics_participants ADD COLUMN device TEXT;
CREATE TABLE analytics_acquisition_daily (
  day TEXT NOT NULL, game TEXT NOT NULL, internal INTEGER NOT NULL, dimension TEXT NOT NULL,
  value TEXT NOT NULL, medium TEXT NOT NULL, campaign TEXT NOT NULL,
  visits INTEGER NOT NULL DEFAULT 0, started INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(day, game, internal, dimension, value, medium, campaign)
);
INSERT INTO analytics_metadata(key,value) VALUES ('acquisition_collected_from', CAST(strftime('%s','now') AS INTEGER)*1000);
CREATE TRIGGER privacy_fence_analytics_sessions BEFORE INSERT ON analytics_sessions
WHEN EXISTS(SELECT 1 FROM deleted_accounts WHERE id=NEW.account_id) BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER privacy_hide_acquisition AFTER INSERT ON deleted_accounts BEGIN
  DELETE FROM analytics_sessions WHERE account_id=NEW.id
    OR id IN (SELECT session_id FROM analytics_pageviews WHERE account_id=NEW.id)
    OR id IN (SELECT session_id FROM analytics_participants WHERE account_id=NEW.id);
END;
