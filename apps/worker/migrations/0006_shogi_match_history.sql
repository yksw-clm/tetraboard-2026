ALTER TABLE account_match_history ADD COLUMN game TEXT NOT NULL DEFAULT 'four-reversi';
CREATE INDEX account_match_history_game_page
  ON account_match_history (account_id, game, mode, started_at_ms DESC, match_id DESC);

CREATE TABLE shogi_match_uploads (
  id TEXT PRIMARY KEY NOT NULL,
  record_json TEXT NOT NULL,
  event_count INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL
);

-- 棋譜行は本体より先に届きます。APIは本体・本人索引で認可するため、
-- 未完成の転送は履歴・戦績・ランキングへ公開されません。
CREATE TABLE shogi_match_chunks (
  match_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  start_index INTEGER NOT NULL,
  event_count INTEGER NOT NULL,
  events_json TEXT NOT NULL,
  PRIMARY KEY (match_id, chunk_index)
);
