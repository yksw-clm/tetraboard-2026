CREATE TABLE tournaments (
  key TEXT PRIMARY KEY NOT NULL,
  public_id INTEGER UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  rules_description TEXT NOT NULL DEFAULT '',
  starts_at_ms INTEGER,
  ends_at_ms INTEGER,
  published INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  rule_version INTEGER NOT NULL DEFAULT 1 CHECK (rule_version = 1),
  finalized_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CHECK (published = 0 OR (public_id > 0 AND starts_at_ms IS NOT NULL AND ends_at_ms > starts_at_ms))
);
CREATE INDEX tournaments_schedule ON tournaments(published, starts_at_ms, ends_at_ms);
CREATE TABLE tournament_entries (
  id TEXT PRIMARY KEY NOT NULL,
  tournament_key TEXT NOT NULL REFERENCES tournaments(key),
  account_id TEXT,
  entered_at_ms INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  UNIQUE(tournament_key, account_id)
);
CREATE INDEX tournament_entries_list ON tournament_entries(tournament_key, entered_at_ms, id);
CREATE TABLE tournament_matches (
  id TEXT PRIMARY KEY NOT NULL,
  tournament_key TEXT NOT NULL REFERENCES tournaments(key),
  room_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('reserved','playing','saving','saved','aborted')),
  started_at_ms INTEGER,
  finished_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX tournament_matches_pending ON tournament_matches(tournament_key, phase);
CREATE TABLE tournament_match_players (
  match_id TEXT NOT NULL REFERENCES tournament_matches(id),
  entry_id TEXT NOT NULL REFERENCES tournament_entries(id),
  account_id TEXT,
  player_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  PRIMARY KEY(match_id, entry_id),
  UNIQUE(match_id, player_id)
);
CREATE TABLE tournament_scores (
  entry_id TEXT PRIMARY KEY NOT NULL REFERENCES tournament_entries(id),
  tournament_key TEXT NOT NULL REFERENCES tournaments(key),
  points_units INTEGER NOT NULL DEFAULT 0,
  games INTEGER NOT NULL DEFAULT 0,
  first INTEGER NOT NULL DEFAULT 0,
  second INTEGER NOT NULL DEFAULT 0,
  third INTEGER NOT NULL DEFAULT 0,
  fourth INTEGER NOT NULL DEFAULT 0,
  knockouts INTEGER NOT NULL DEFAULT 0,
  rank_sum INTEGER NOT NULL DEFAULT 0,
  final_rank INTEGER
);
CREATE INDEX tournament_scores_ranking ON tournament_scores(tournament_key, points_units DESC, knockouts DESC);
CREATE TABLE tournament_point_events (
  match_id TEXT NOT NULL REFERENCES tournament_matches(id),
  entry_id TEXT NOT NULL REFERENCES tournament_entries(id),
  rank INTEGER NOT NULL CHECK(rank BETWEEN 1 AND 4),
  knockouts INTEGER NOT NULL CHECK(knockouts BETWEEN 0 AND 3),
  points_units INTEGER NOT NULL CHECK(points_units >= 0),
  PRIMARY KEY(match_id, entry_id)
);
CREATE TRIGGER tournament_score_apply AFTER INSERT ON tournament_point_events BEGIN
  INSERT INTO tournament_scores(entry_id,tournament_key,points_units,games,first,second,third,fourth,knockouts,rank_sum)
  SELECT NEW.entry_id,m.tournament_key,NEW.points_units,1,
    NEW.rank=1,NEW.rank=2,NEW.rank=3,NEW.rank=4,NEW.knockouts,NEW.rank
  FROM tournament_matches m WHERE m.id=NEW.match_id
  ON CONFLICT(entry_id) DO UPDATE SET
    points_units=points_units+NEW.points_units,games=games+1,
    first=first+(NEW.rank=1),second=second+(NEW.rank=2),third=third+(NEW.rank=3),fourth=fourth+(NEW.rank=4),
    knockouts=knockouts+NEW.knockouts,rank_sum=rank_sum+NEW.rank;
END;
CREATE TABLE tournament_wait_reservations (
  account_id TEXT PRIMARY KEY NOT NULL,
  tournament_key TEXT NOT NULL REFERENCES tournaments(key),
  operation_id TEXT NOT NULL UNIQUE,
  lease_until_ms INTEGER NOT NULL,
  match_operation_id TEXT
);
CREATE TRIGGER tournament_wait_fence BEFORE INSERT ON tournament_wait_reservations BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM account_room_seats WHERE account_id=NEW.account_id)
    THEN RAISE(ABORT,'account_seated') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM deleted_accounts WHERE id=NEW.account_id)
    THEN RAISE(ABORT,'account_deleted') END;
END;
CREATE TRIGGER tournament_room_fence BEFORE INSERT ON account_room_seats
WHEN EXISTS(SELECT 1 FROM tournament_wait_reservations w WHERE w.account_id=NEW.account_id AND (w.match_operation_id IS NULL OR w.match_operation_id != NEW.operation_id))
BEGIN SELECT RAISE(ABORT,'tournament_waiting'); END;
CREATE TRIGGER tournament_entry_deleted_fence BEFORE INSERT ON tournament_entries
WHEN NEW.account_id IS NOT NULL AND EXISTS(SELECT 1 FROM deleted_accounts WHERE id=NEW.account_id)
BEGIN SELECT RAISE(ABORT,'account_deleted'); END;
ALTER TABLE room_index ADD COLUMN tournament_id INTEGER;
