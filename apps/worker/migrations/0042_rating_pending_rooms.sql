ALTER TABLE four_reversi_rating_pending ADD COLUMN room_id TEXT;
ALTER TABLE four_reversi_rating_pending ADD COLUMN instance_id TEXT;
ALTER TABLE four_shogi_rating_pending ADD COLUMN room_id TEXT;
ALTER TABLE four_shogi_rating_pending ADD COLUMN instance_id TEXT;
ALTER TABLE shogi_rating_pending ADD COLUMN room_id TEXT;
ALTER TABLE shogi_rating_pending ADD COLUMN instance_id TEXT;
ALTER TABLE reversi_rating_pending ADD COLUMN room_id TEXT;
ALTER TABLE reversi_rating_pending ADD COLUMN instance_id TEXT;

UPDATE four_reversi_rating_pending SET (room_id, instance_id) = (
  SELECT room_id, instance_id FROM account_room_seats
  WHERE operation_id = four_reversi_rating_pending.match_id || ':' || four_reversi_rating_pending.account_id
);
UPDATE four_shogi_rating_pending SET (room_id, instance_id) = (
  SELECT room_id, instance_id FROM account_room_seats
  WHERE operation_id = four_shogi_rating_pending.match_id || ':' || four_shogi_rating_pending.account_id
);
UPDATE shogi_rating_pending SET (room_id, instance_id) = (
  SELECT room_id, instance_id FROM account_room_seats
  WHERE operation_id = shogi_rating_pending.match_id || ':' || shogi_rating_pending.account_id
);
UPDATE reversi_rating_pending SET (room_id, instance_id) = (
  SELECT room_id, instance_id FROM account_room_seats
  WHERE operation_id = reversi_rating_pending.match_id || ':' || reversi_rating_pending.account_id
);
