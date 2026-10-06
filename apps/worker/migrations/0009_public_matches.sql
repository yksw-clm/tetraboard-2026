CREATE INDEX matches_game_recent
  ON matches (game, started_at_ms DESC, id DESC);
