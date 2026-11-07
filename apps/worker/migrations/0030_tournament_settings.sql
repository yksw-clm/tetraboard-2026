PRAGMA defer_foreign_keys = ON;
CREATE TABLE tournaments_new (
  key TEXT PRIMARY KEY NOT NULL,
  public_id INTEGER UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  rules_description TEXT NOT NULL DEFAULT '',
  starts_at_ms INTEGER,
  ends_at_ms INTEGER,
  published INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  rule_version INTEGER NOT NULL DEFAULT 1 CHECK (rule_version IN (1,2)),
  finalized_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  chat_accepting INTEGER NOT NULL DEFAULT 1 CHECK(chat_accepting IN (0,1)),
  game TEXT NOT NULL DEFAULT 'four-shogi' CHECK(game IN ('four-shogi','four-reversi','four-gomoku')),
  settings_json TEXT,
  CHECK (rule_version=1 OR (settings_json IS NOT NULL AND json_valid(settings_json) AND json_extract(settings_json,'$.game') IS game)),
  CHECK (published = 0 OR (public_id > 0 AND starts_at_ms IS NOT NULL AND ends_at_ms > starts_at_ms))
);
INSERT INTO tournaments_new(key,public_id,name,description,rules_description,starts_at_ms,ends_at_ms,published,version,rule_version,finalized_at_ms,created_at_ms,updated_at_ms,chat_accepting)
SELECT key,public_id,name,description,rules_description,starts_at_ms,ends_at_ms,published,version,rule_version,finalized_at_ms,created_at_ms,updated_at_ms,chat_accepting FROM tournaments;
DROP TABLE tournaments;
ALTER TABLE tournaments_new RENAME TO tournaments;
CREATE INDEX tournaments_schedule ON tournaments(published, starts_at_ms, ends_at_ms);
CREATE INDEX tournaments_game_schedule ON tournaments(game,published,starts_at_ms,public_id);
PRAGMA defer_foreign_keys = OFF;
