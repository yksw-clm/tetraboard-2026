-- External profile images are no longer supported.
UPDATE user SET image = NULL WHERE avatarKey IS NULL AND image IS NOT NULL;

ALTER TABLE room_index ADD COLUMN host_avatar_url TEXT;

-- A reservation is confirmed by its GameRoom; age alone never releases a seat.
CREATE TABLE account_room_seats (
  account_id TEXT PRIMARY KEY NOT NULL,
  operation_id TEXT UNIQUE NOT NULL,
  room_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  name TEXT NOT NULL,
  avatar_key TEXT,
  created_at_ms INTEGER NOT NULL,
  checked_at_ms INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE room_avatar_refs (
  operation_id TEXT PRIMARY KEY NOT NULL,
  room_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  avatar_key TEXT NOT NULL
);
CREATE INDEX room_avatar_refs_key ON room_avatar_refs (avatar_key);
