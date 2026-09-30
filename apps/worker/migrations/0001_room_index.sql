CREATE TABLE room_index (
  room_id TEXT PRIMARY KEY NOT NULL,
  game TEXT NOT NULL,
  mode TEXT NOT NULL,
  main_time_ms INTEGER NOT NULL,
  byoyomi_ms INTEGER NOT NULL,
  status TEXT NOT NULL,
  host_name TEXT,
  human_count INTEGER NOT NULL,
  cpu_count INTEGER NOT NULL,
  capacity INTEGER NOT NULL,
  open_seats INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  closed INTEGER NOT NULL DEFAULT 0 CHECK (closed IN (0, 1))
);

CREATE INDEX room_index_public_order
  ON room_index (closed, updated_at_ms DESC, room_id DESC);
