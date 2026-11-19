DROP TRIGGER IF EXISTS lobby_chat_accept;
DROP TRIGGER IF EXISTS notification_announcement_insert;
DROP TRIGGER IF EXISTS notification_announcement_publish;
DROP TRIGGER IF EXISTS notification_badge;

-- 旧 Worker が date だけを更新した記事も、最新の日付を引き継ぎます。
UPDATE announcements SET published_on = date;

CREATE TABLE announcements_new (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  date TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('improvement', 'feature', 'tournament', 'other')),
  published INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0, 1)),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  published_on TEXT NOT NULL
);
INSERT INTO announcements_new (id, title, body, date, kind, published, created_at_ms, updated_at_ms, version, published_on)
SELECT id, title, body, date, kind, published, created_at_ms, updated_at_ms, version, published_on
FROM announcements;

-- D1 では外部キーの検査を遅らせても CASCADE が働くため、掲載先を退避してから親表を作り直します。
CREATE TABLE announcement_lobby_targets_backup AS
SELECT announcement_id, game FROM announcement_lobby_targets;
DROP TABLE announcement_lobby_targets;
DROP TABLE announcements;
ALTER TABLE announcements_new RENAME TO announcements;

CREATE TABLE announcement_lobby_targets (
  announcement_id TEXT NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  game TEXT NOT NULL,
  PRIMARY KEY (announcement_id, game)
);
INSERT INTO announcement_lobby_targets (announcement_id, game)
SELECT announcement_id, game FROM announcement_lobby_targets_backup;
DROP TABLE announcement_lobby_targets_backup;

CREATE INDEX announcements_published_on_order ON announcements(published_on DESC, created_at_ms DESC, id DESC);
CREATE INDEX announcements_public_published_on_order ON announcements(published, published_on DESC, created_at_ms DESC, id DESC);
CREATE INDEX announcement_targets_game ON announcement_lobby_targets(game, announcement_id);
