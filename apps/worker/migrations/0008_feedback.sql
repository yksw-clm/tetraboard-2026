CREATE TABLE feedback_topics (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE feedback (
  id TEXT PRIMARY KEY, submission_id TEXT NOT NULL UNIQUE, payload_hash TEXT NOT NULL,
  author TEXT NOT NULL, reporter_hash TEXT NOT NULL, internal INTEGER NOT NULL,
  kind TEXT NOT NULL, game TEXT NOT NULL, body TEXT NOT NULL,
  expectation TEXT NOT NULL, steps TEXT NOT NULL, technical TEXT,
  received_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL,
  first_reviewed_at_ms INTEGER, status TEXT NOT NULL DEFAULT 'new',
  priority TEXT NOT NULL DEFAULT 'normal', topic_id TEXT REFERENCES feedback_topics(id),
  note TEXT NOT NULL DEFAULT '', issue_url TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1,
  attachment_key TEXT, ready INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX feedback_newest ON feedback (ready, deleted, received_at_ms DESC, id DESC);
CREATE INDEX feedback_expiry ON feedback (expires_at_ms);
CREATE TABLE feedback_history (
  id TEXT PRIMARY KEY, feedback_id TEXT NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
  admin_id TEXT NOT NULL, admin_name TEXT NOT NULL, at_ms INTEGER NOT NULL, changes TEXT NOT NULL
);
CREATE INDEX feedback_history_record ON feedback_history (feedback_id, at_ms);
CREATE TABLE feedback_limits (
  key TEXT NOT NULL, window_ms INTEGER NOT NULL, count INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL, PRIMARY KEY(key, window_ms)
);
CREATE INDEX feedback_limits_expiry ON feedback_limits(expires_at_ms);
CREATE TABLE feedback_uploads (key TEXT PRIMARY KEY, created_at_ms INTEGER NOT NULL);
