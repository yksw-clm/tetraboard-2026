CREATE TABLE four_reversi_rating_pending (
  account_id TEXT PRIMARY KEY NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  match_id TEXT NOT NULL
);
CREATE INDEX four_reversi_rating_pending_match ON four_reversi_rating_pending(match_id);

CREATE TRIGGER four_reversi_rating_pending_account_deleted AFTER INSERT ON deleted_accounts BEGIN
  DELETE FROM four_reversi_rating_pending WHERE account_id = NEW.id;
END;
