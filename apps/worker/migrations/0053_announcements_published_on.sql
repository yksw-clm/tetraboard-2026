ALTER TABLE announcements ADD COLUMN published_on TEXT;
UPDATE announcements SET published_on = date;
CREATE INDEX announcements_published_on_order
  ON announcements(COALESCE(published_on, date) DESC, created_at_ms DESC, id DESC);
CREATE INDEX announcements_public_published_on_order
  ON announcements(published, COALESCE(published_on, date) DESC, created_at_ms DESC, id DESC);
