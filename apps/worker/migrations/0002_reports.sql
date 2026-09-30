CREATE TABLE reports (
  id TEXT PRIMARY KEY NOT NULL,
  room_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  sender_name TEXT NOT NULL,
  body TEXT NOT NULL,
  sent_at_ms INTEGER NOT NULL,
  reporter_hash TEXT NOT NULL,
  reported_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  action TEXT,
  UNIQUE (instance_id, message_id, reporter_hash)
);

CREATE INDEX reports_order ON reports (reported_at_ms DESC, id DESC);
CREATE INDEX reports_expiry ON reports (expires_at_ms);
CREATE INDEX reports_reporter_time ON reports (instance_id, reporter_hash, reported_at_ms DESC);
