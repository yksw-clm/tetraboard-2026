CREATE TABLE matches (
  id TEXT PRIMARY KEY NOT NULL,
  game TEXT NOT NULL,
  mode TEXT NOT NULL,
  started_at_ms INTEGER NOT NULL,
  ended_at_ms INTEGER NOT NULL,
  record_json TEXT NOT NULL
);

CREATE TABLE account_match_history (
  account_id TEXT NOT NULL,
  match_id TEXT NOT NULL REFERENCES matches (id),
  mode TEXT NOT NULL,
  started_at_ms INTEGER NOT NULL,
  PRIMARY KEY (account_id, match_id)
);
CREATE INDEX account_match_history_page
  ON account_match_history (account_id, mode, started_at_ms DESC, match_id DESC);
