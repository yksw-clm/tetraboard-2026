CREATE TABLE shogi_match_formations (
  match_id TEXT PRIMARY KEY NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  analyzer_id TEXT NOT NULL,
  analysis_version INTEGER NOT NULL,
  rules_version INTEGER NOT NULL,
  used_by_side_json TEXT NOT NULL
);
