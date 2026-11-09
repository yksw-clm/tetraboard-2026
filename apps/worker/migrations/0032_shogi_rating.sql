CREATE TABLE shogi_rating_changes (
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  rating_before REAL NOT NULL,
  rating_after REAL NOT NULL,
  rated_games INTEGER NOT NULL,
  human_games INTEGER NOT NULL,
  PRIMARY KEY (match_id, account_id),
  UNIQUE (account_id, rated_games)
);

CREATE TRIGGER shogi_rating_account_deleted AFTER INSERT ON deleted_accounts BEGIN
  DELETE FROM shogi_rating_changes WHERE account_id = NEW.id;
END;
