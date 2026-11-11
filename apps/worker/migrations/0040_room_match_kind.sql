ALTER TABLE room_index ADD COLUMN match_kind TEXT
  CHECK (match_kind IN ('rated', 'tournament', 'normal', 'unknown'));

-- 旧ランダムマッチとレート戦の区別は、稼働中のルームから再取得します。
UPDATE room_index SET match_kind = CASE
  WHEN tournament_id IS NOT NULL THEN 'tournament'
  WHEN matchmaking = 0 THEN 'normal'
  ELSE NULL
END;
