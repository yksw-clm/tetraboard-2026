ALTER TABLE user ADD COLUMN publicProfileId TEXT;
UPDATE user SET publicProfileId = lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-8' || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))) WHERE publicProfileId IS NULL;
CREATE UNIQUE INDEX user_public_profile_id_idx ON user(publicProfileId);
ALTER TABLE room_index ADD COLUMN instance_id TEXT;
ALTER TABLE room_index ADD COLUMN host_player_id TEXT;
