CREATE INDEX deletion_rooms_by_room ON deletion_rooms (room_id, account_id);
CREATE INDEX matches_recent ON matches (started_at_ms DESC, id DESC);
