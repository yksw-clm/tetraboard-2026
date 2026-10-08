CREATE TABLE IF NOT EXISTS announcements (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  date TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('improvement', 'feature', 'tournament', 'other')),
  published INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0, 1)),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)
);
CREATE INDEX IF NOT EXISTS announcements_order ON announcements(date DESC, created_at_ms DESC, id DESC);
CREATE INDEX IF NOT EXISTS announcements_public_order ON announcements(published, date DESC, created_at_ms DESC, id DESC);
CREATE TABLE IF NOT EXISTS announcement_lobby_targets (
  announcement_id TEXT NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  game TEXT NOT NULL,
  PRIMARY KEY (announcement_id, game)
);
CREATE INDEX IF NOT EXISTS announcement_targets_game ON announcement_lobby_targets(game, announcement_id);
INSERT INTO announcements (id, title, body, date, kind, published, created_at_ms, updated_at_ms, version)
VALUES ('feedback', '不具合やご意見を送れるようになりました', '登録なしで、不具合や機能のアイデアを送れます。画像も1枚添付できます。いただいた声を、これからの改善に役立てます。', '2026-10-04', 'feature', 1, 1791039600000, 1791039600000, 1)
ON CONFLICT(id) DO NOTHING;
