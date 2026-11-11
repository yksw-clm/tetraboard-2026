CREATE TABLE shogi_rating_pending (
  account_id TEXT PRIMARY KEY NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  match_id TEXT NOT NULL
);
CREATE INDEX shogi_rating_pending_match ON shogi_rating_pending(match_id);

CREATE TRIGGER shogi_rating_pending_account_deleted AFTER INSERT ON deleted_accounts BEGIN
  DELETE FROM shogi_rating_pending WHERE account_id = NEW.id;
END;
