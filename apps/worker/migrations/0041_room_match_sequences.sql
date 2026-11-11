CREATE TABLE room_match_sequences (
  match_id TEXT PRIMARY KEY NOT NULL,
  scope TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence BETWEEN 1 AND 9007199254740991),
  UNIQUE(scope, sequence)
);

ALTER TABLE room_index ADD COLUMN match_sequence INTEGER
  CHECK (match_sequence BETWEEN 1 AND 9007199254740991);
