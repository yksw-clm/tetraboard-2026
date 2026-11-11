CREATE TABLE matchmaking_wait_reservations (
  account_id TEXT PRIMARY KEY NOT NULL REFERENCES user(id),
  queue_key TEXT NOT NULL,
  operation_id TEXT NOT NULL UNIQUE,
  lease_until_ms INTEGER NOT NULL,
  match_operation_id TEXT
);
CREATE TRIGGER matchmaking_wait_fence BEFORE INSERT ON matchmaking_wait_reservations BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM account_room_seats WHERE account_id=NEW.account_id)
    OR EXISTS(SELECT 1 FROM tournament_wait_reservations WHERE account_id=NEW.account_id)
    THEN RAISE(ABORT,'account_busy') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM deleted_accounts WHERE id=NEW.account_id)
    OR EXISTS(SELECT 1 FROM guest_account_merges WHERE guest_id=NEW.account_id)
    THEN RAISE(ABORT,'account_deleted') END;
END;
CREATE TRIGGER matchmaking_room_fence BEFORE INSERT ON account_room_seats
WHEN EXISTS(SELECT 1 FROM matchmaking_wait_reservations w WHERE w.account_id=NEW.account_id AND (w.match_operation_id IS NULL OR w.match_operation_id != NEW.operation_id))
BEGIN SELECT RAISE(ABORT,'matchmaking_waiting'); END;
CREATE TRIGGER matchmaking_tournament_fence BEFORE INSERT ON tournament_wait_reservations
WHEN EXISTS(SELECT 1 FROM matchmaking_wait_reservations WHERE account_id=NEW.account_id)
BEGIN SELECT RAISE(ABORT,'matchmaking_waiting'); END;
CREATE TRIGGER matchmaking_login_transition_fence BEFORE INSERT ON guest_promotions
WHEN EXISTS(SELECT 1 FROM matchmaking_wait_reservations WHERE account_id IN(NEW.guest_id,NEW.temporary_id))
BEGIN SELECT RAISE(ABORT,'account_busy'); END;
CREATE TRIGGER matchmaking_guest_merge_fence BEFORE INSERT ON guest_account_merges
WHEN EXISTS(SELECT 1 FROM matchmaking_wait_reservations WHERE account_id IN(NEW.guest_id,NEW.account_id))
BEGIN SELECT RAISE(ABORT,'account_busy'); END;
ALTER TABLE room_index ADD COLUMN matchmaking INTEGER NOT NULL DEFAULT 0;
