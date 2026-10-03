CREATE TABLE analytics_metadata (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
CREATE TABLE analytics_pageviews (
  id TEXT PRIMARY KEY, visitor_id TEXT NOT NULL, account_id TEXT,
  is_test INTEGER NOT NULL DEFAULT 0, page TEXT NOT NULL, game TEXT,
  started_at_ms INTEGER NOT NULL
);
CREATE INDEX analytics_pageviews_period ON analytics_pageviews (started_at_ms, game);
CREATE INDEX analytics_pageviews_visitor ON analytics_pageviews (visitor_id, started_at_ms);
CREATE TABLE analytics_dwell (
  view_id TEXT NOT NULL REFERENCES analytics_pageviews(id), day TEXT NOT NULL,
  milliseconds INTEGER NOT NULL, PRIMARY KEY (view_id, day)
);
CREATE INDEX analytics_dwell_day ON analytics_dwell (day);
CREATE TABLE analytics_matches (
  id TEXT PRIMARY KEY, game TEXT NOT NULL, mode TEXT NOT NULL,
  started_at_ms INTEGER NOT NULL, ended_at_ms INTEGER,
  status TEXT NOT NULL, cpu_count INTEGER NOT NULL
);
CREATE INDEX analytics_matches_period ON analytics_matches (started_at_ms, game);
CREATE TABLE analytics_participants (
  match_id TEXT NOT NULL REFERENCES analytics_matches(id), player_id TEXT NOT NULL,
  account_id TEXT, visitor_id TEXT, is_test INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (match_id, player_id)
);
CREATE INDEX analytics_participants_account ON analytics_participants (account_id, match_id);
CREATE INDEX analytics_participants_visitor ON analytics_participants (visitor_id, match_id);
