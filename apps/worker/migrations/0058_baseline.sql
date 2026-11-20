-- 0001〜0057 を適用したスキーマと初期データです。空の D1 に適用します。

CREATE TABLE "user" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL UNIQUE,
  "emailVerified" INTEGER NOT NULL,
  "image" TEXT,
  "createdAt" INTEGER NOT NULL,
  "updatedAt" INTEGER NOT NULL,
  "isAnonymous" INTEGER,
  "username" TEXT UNIQUE,
  "profileCompleted" INTEGER,
  "avatarKey" TEXT,
  "isTestUser" INTEGER,
  "guestNameCustomized" INTEGER,
  publicProfileId TEXT,
  guestRegisteredAt INTEGER,
  avatarPresetId TEXT,
  profileMessage TEXT NOT NULL DEFAULT '',
  favoriteGames TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE "account" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "accountId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "accessToken" TEXT,
  "refreshToken" TEXT,
  "idToken" TEXT,
  "accessTokenExpiresAt" INTEGER,
  "refreshTokenExpiresAt" INTEGER,
  "scope" TEXT,
  "password" TEXT,
  "createdAt" INTEGER NOT NULL,
  "updatedAt" INTEGER NOT NULL
);

CREATE TABLE account_badge_awards (
  account_id TEXT NOT NULL,
  game TEXT NOT NULL CHECK (game IN ('four-reversi', 'four-shogi')),
  badge_id TEXT NOT NULL,
  tier INTEGER NOT NULL CHECK (tier BETWEEN 1 AND 3),
  value INTEGER NOT NULL,
  previous_tier INTEGER NOT NULL CHECK (previous_tier BETWEEN 0 AND 3),
  match_id TEXT,
  PRIMARY KEY (account_id, game, badge_id, tier)
);

CREATE TABLE account_badge_notifications (
  account_id TEXT NOT NULL,
  match_id TEXT NOT NULL,
  game TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  shown_at_ms INTEGER,
  claim_token TEXT,
  claim_until_ms INTEGER,
  PRIMARY KEY (account_id, match_id)
);

CREATE TABLE matches (
  id TEXT PRIMARY KEY NOT NULL,
  game TEXT NOT NULL,
  mode TEXT NOT NULL,
  started_at_ms INTEGER NOT NULL,
  ended_at_ms INTEGER NOT NULL,
  record_json TEXT NOT NULL
);

CREATE TABLE account_match_history (
  account_id TEXT NOT NULL,
  match_id TEXT NOT NULL REFERENCES matches (id),
  mode TEXT NOT NULL,
  started_at_ms INTEGER NOT NULL,
  game TEXT NOT NULL DEFAULT 'four-reversi',
  PRIMARY KEY (account_id, match_id)
);

CREATE TABLE notification_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK(kind IN ('announcement','tournament','badge')),
  source_id TEXT NOT NULL,
  account_id TEXT NOT NULL DEFAULT '',
  created_at_ms INTEGER NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  legacy INTEGER NOT NULL DEFAULT 0,
  UNIQUE(kind,source_id,account_id)
);

CREATE TABLE account_notification_reads (
  account_id TEXT NOT NULL,
  notification_seq INTEGER NOT NULL REFERENCES notification_events(seq) ON DELETE CASCADE,
  PRIMARY KEY(account_id,notification_seq)
);

CREATE TABLE account_notification_state (
  account_id TEXT PRIMARY KEY,
  baseline_seq INTEGER NOT NULL,
  read_all_seq INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE account_room_seats (
  account_id TEXT PRIMARY KEY NOT NULL,
  operation_id TEXT UNIQUE NOT NULL,
  room_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  name TEXT NOT NULL,
  avatar_key TEXT,
  created_at_ms INTEGER NOT NULL,
  checked_at_ms INTEGER NOT NULL DEFAULT 0,
  avatar_preset_id TEXT
);

CREATE TABLE "announcements" (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('improvement', 'feature', 'tournament', 'other')),
  published INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0, 1)),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  published_on TEXT NOT NULL
);

CREATE TABLE announcement_lobby_targets (
  announcement_id TEXT NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  game TEXT NOT NULL,
  PRIMARY KEY (announcement_id, game)
);

CREATE TABLE avatar_deletions (
  key TEXT PRIMARY KEY NOT NULL
);

CREATE TABLE deleted_accounts (
  id TEXT PRIMARY KEY,
  requested_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER,
  receipt_hash TEXT NOT NULL UNIQUE,
  avatar_key TEXT,
  provider TEXT,
  revocation_token TEXT,
  last_attempted_at_ms INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE deletion_challenges (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  verified_at_ms INTEGER,
  oauth_state TEXT,
  verified_session_id TEXT
);

CREATE TABLE deletion_flows (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL
);

CREATE TABLE deletion_images (
  account_id TEXT NOT NULL REFERENCES deleted_accounts(id),
  key TEXT NOT NULL,
  PRIMARY KEY(account_id,key)
);

CREATE TABLE deletion_rooms (
  account_id TEXT NOT NULL REFERENCES deleted_accounts(id),
  room_id TEXT NOT NULL,
  PRIMARY KEY(account_id,room_id)
);

CREATE TABLE `elo_rating_changes` (
  `game` text NOT NULL,
  `match_id` text NOT NULL,
  `account_id` text NOT NULL,
  `rating_before` real NOT NULL,
  `rating_after` real NOT NULL,
  `rated_games` integer NOT NULL,
  `human_games` integer NOT NULL,
  PRIMARY KEY(`match_id`, `account_id`),
  FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`account_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE `elo_rating_pending` (
  `game` text NOT NULL,
  `account_id` text NOT NULL,
  `match_id` text NOT NULL,
  `room_id` text,
  `instance_id` text,
  PRIMARY KEY(`game`, `account_id`),
  FOREIGN KEY (`account_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE feedback_topics (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE feedback (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL UNIQUE,
  payload_hash TEXT NOT NULL,
  author TEXT NOT NULL,
  reporter_hash TEXT NOT NULL,
  internal INTEGER NOT NULL,
  kind TEXT NOT NULL,
  game TEXT NOT NULL,
  body TEXT NOT NULL,
  expectation TEXT NOT NULL,
  steps TEXT NOT NULL,
  technical TEXT,
  received_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  first_reviewed_at_ms INTEGER,
  status TEXT NOT NULL DEFAULT 'new',
  priority TEXT NOT NULL DEFAULT 'normal',
  topic_id TEXT REFERENCES feedback_topics(id),
  note TEXT NOT NULL DEFAULT '',
  issue_url TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  attachment_key TEXT,
  ready INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  account_id TEXT,
  rating INTEGER CHECK (rating BETWEEN 1 AND 5),
  opponent TEXT CHECK (opponent IN ('cpu', 'human'))
);

CREATE TABLE feedback_history (
  id TEXT PRIMARY KEY,
  feedback_id TEXT NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
  admin_id TEXT NOT NULL,
  admin_name TEXT NOT NULL,
  at_ms INTEGER NOT NULL,
  changes TEXT NOT NULL
);

CREATE TABLE feedback_limits (
  key TEXT NOT NULL,
  window_ms INTEGER NOT NULL,
  count INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  PRIMARY KEY(key, window_ms)
);

CREATE TABLE feedback_uploads (
  key TEXT PRIMARY KEY,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE "four_shogi_formation_usages" (
  match_id TEXT PRIMARY KEY NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  analyzer_id TEXT NOT NULL,
  analysis_version INTEGER NOT NULL,
  rules_version INTEGER NOT NULL,
  used_by_side_json TEXT NOT NULL
);

CREATE TABLE guest_account_merges (
  guest_id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL,
  merged_at_ms INTEGER NOT NULL,
  CHECK(guest_id != account_id)
);

CREATE TABLE guest_oauth_flows (
  state TEXT PRIMARY KEY NOT NULL,
  guest_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  guest_token_hash TEXT NOT NULL,
  provider TEXT NOT NULL,
  started_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  target_id TEXT,
  target_session_id TEXT,
  is_new_target INTEGER NOT NULL DEFAULT 0,
  room_registration_id TEXT
);

CREATE TABLE guest_promotions (
  guest_id TEXT PRIMARY KEY NOT NULL,
  temporary_id TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL,
  session_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE registration_flows (
  id TEXT PRIMARY KEY NOT NULL,
  secret_hash TEXT NOT NULL,
  room_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  match_id TEXT NOT NULL,
  player_id TEXT,
  old_token_hash TEXT NOT NULL,
  new_token_hash TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  hold_until_ms INTEGER NOT NULL,
  claim_until_ms INTEGER NOT NULL,
  account_id TEXT,
  session_id TEXT,
  cancelled_at_ms INTEGER,
  record_accepted_at_ms INTEGER,
  seat_state TEXT NOT NULL DEFAULT 'held',
  guest_account_id TEXT
);

CREATE TABLE guest_room_link_commits (
  registration_id TEXT PRIMARY KEY NOT NULL,
  guest_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  oauth_state TEXT NOT NULL,
  committed_at_ms INTEGER NOT NULL,
  FOREIGN KEY (registration_id) REFERENCES registration_flows(id) ON DELETE CASCADE
);

CREATE TABLE guest_sessions (
  token_hash TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  expires_at_ms INTEGER NOT NULL,
  registered_at_ms INTEGER
);

CREATE TABLE kpi_monthly (
  month TEXT NOT NULL,
  metric TEXT NOT NULL,
  value REAL NOT NULL,
  computed_at_ms INTEGER NOT NULL,
  PRIMARY KEY (month, metric)
);

CREATE TABLE legal_consents (
  account_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  accepted_at_ms INTEGER NOT NULL
);

CREATE TABLE "tournaments" (
  key TEXT PRIMARY KEY NOT NULL,
  public_id INTEGER UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  rules_description TEXT NOT NULL DEFAULT '',
  starts_at_ms INTEGER,
  ends_at_ms INTEGER,
  published INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  rule_version INTEGER NOT NULL DEFAULT 1 CHECK (rule_version IN (1,2)),
  finalized_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  chat_accepting INTEGER NOT NULL DEFAULT 1 CHECK(chat_accepting IN (0,1)),
  game TEXT NOT NULL DEFAULT 'four-shogi' CHECK(game IN ('four-shogi','four-reversi','four-gomoku')),
  settings_json TEXT,
  CHECK (rule_version=1 OR (settings_json IS NOT NULL AND json_valid(settings_json) AND json_extract(settings_json,'$.game') IS game)),
  CHECK (published = 0 OR (public_id > 0 AND starts_at_ms IS NOT NULL AND ends_at_ms > starts_at_ms))
);

CREATE TABLE lobby_chat_messages (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  body TEXT NOT NULL,
  sent_at_ms INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  sender_public_id TEXT,
  tournament_id INTEGER REFERENCES tournaments(public_id),
  UNIQUE(account_id,request_id)
);

CREATE TABLE lobby_chat_reports (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  sender_account_id TEXT,
  sender_public_id TEXT,
  sender_name TEXT NOT NULL,
  body TEXT NOT NULL,
  sent_at_ms INTEGER NOT NULL,
  reporter_account_id TEXT,
  reported_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  tournament_id INTEGER,
  UNIQUE(message_id,reporter_account_id)
);

CREATE TABLE lobby_chat_requests (
  account_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  sent_at_ms INTEGER NOT NULL,
  tournament_id INTEGER,
  PRIMARY KEY(account_id,request_id)
);

CREATE TABLE lobby_chat_senders (
  account_id TEXT PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  last_sent_at_ms INTEGER NOT NULL DEFAULT 0,
  stopped INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE lobby_chat_settings (
  id INTEGER PRIMARY KEY CHECK(id=1),
  accepting INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE "match_event_chunks" (
  match_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  start_index INTEGER NOT NULL,
  event_count INTEGER NOT NULL,
  events_json TEXT NOT NULL,
  PRIMARY KEY (match_id, chunk_index)
);

CREATE TABLE match_participant_accounts (
  match_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  account_id TEXT,
  room_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending', 'applied', 'retired', 'rejected')),
  accepted_at_ms INTEGER NOT NULL,
  retry_at_ms INTEGER NOT NULL,
  PRIMARY KEY(match_id, player_id),
  UNIQUE(match_id, account_id),
  CHECK((state IN ('retired','rejected') AND account_id IS NULL) OR (state IN ('pending','applied') AND account_id IS NOT NULL))
);

CREATE TABLE "match_uploads" (
  id TEXT PRIMARY KEY NOT NULL,
  record_json TEXT NOT NULL,
  event_count INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL
);

CREATE TABLE matchmaking_wait_reservations (
  account_id TEXT PRIMARY KEY NOT NULL REFERENCES user(id),
  queue_key TEXT NOT NULL,
  operation_id TEXT NOT NULL UNIQUE,
  lease_until_ms INTEGER NOT NULL,
  match_operation_id TEXT
);

CREATE TABLE notification_metadata (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

CREATE TABLE oauth_legal_consents (
  state TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  version TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL
);

CREATE TABLE privacy_avatar_uploads (
  key TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  started_at_ms INTEGER NOT NULL
);

CREATE TABLE privacy_room_accounts (
  account_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  PRIMARY KEY(account_id,room_id)
);

CREATE TABLE privacy_room_players (
  account_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  avatar_key TEXT,
  PRIMARY KEY(account_id,room_id,instance_id,player_id)
);

CREATE TABLE "rateLimit" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "key" TEXT NOT NULL UNIQUE,
  "count" INTEGER NOT NULL,
  "lastRequest" INTEGER NOT NULL
);

CREATE TABLE registration_oauth_states (
  state TEXT PRIMARY KEY NOT NULL,
  registration_id TEXT NOT NULL REFERENCES registration_flows(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL
);

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

CREATE TABLE room_avatar_refs (
  operation_id TEXT PRIMARY KEY NOT NULL,
  room_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  avatar_key TEXT NOT NULL
);

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
  closed INTEGER NOT NULL DEFAULT 0 CHECK (closed IN (0, 1)),
  host_avatar_url TEXT,
  instance_id TEXT,
  host_player_id TEXT,
  tournament_id INTEGER,
  participants_json TEXT,
  matchmaking INTEGER NOT NULL DEFAULT 0,
  match_kind TEXT CHECK (match_kind IN ('rated', 'tournament', 'normal', 'unknown')),
  match_sequence INTEGER CHECK (match_sequence BETWEEN 1 AND 9007199254740991),
  `closed_at_ms` integer,
  `closed_observed_at_ms` integer
);

CREATE TABLE `room_index_deleted_revisions` (
  `room_id` text PRIMARY KEY NOT NULL,
  `deleted_through_revision` integer NOT NULL
);

CREATE TABLE `room_index_retention_cursor` (
  `id` integer PRIMARY KEY NOT NULL,
  `closed_sort_at_ms` integer NOT NULL,
  `room_id` text NOT NULL,
  CONSTRAINT "room_index_retention_singleton" CHECK(id = 1)
);

CREATE TABLE room_match_sequences (
  match_id TEXT PRIMARY KEY NOT NULL,
  scope TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence BETWEEN 1 AND 9007199254740991),
  UNIQUE(scope, sequence)
);

CREATE TABLE "session" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "expiresAt" INTEGER NOT NULL,
  "token" TEXT NOT NULL UNIQUE,
  "createdAt" INTEGER NOT NULL,
  "updatedAt" INTEGER NOT NULL,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE
);

CREATE TABLE `skill_rating_changes` (
  `game` text NOT NULL,
  `match_id` text NOT NULL,
  `account_id` text NOT NULL,
  `mu_before` real NOT NULL,
  `sigma_before` real NOT NULL,
  `mu_after` real NOT NULL,
  `sigma_after` real NOT NULL,
  `rated_games` integer NOT NULL,
  `human_games` integer NOT NULL,
  PRIMARY KEY(`match_id`, `account_id`),
  FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`account_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE `skill_rating_pending` (
  `game` text NOT NULL,
  `account_id` text NOT NULL,
  `match_id` text NOT NULL,
  `room_id` text,
  `instance_id` text,
  PRIMARY KEY(`game`, `account_id`),
  FOREIGN KEY (`account_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE tournament_entries (
  id TEXT PRIMARY KEY NOT NULL,
  tournament_key TEXT NOT NULL REFERENCES tournaments(key),
  account_id TEXT,
  entered_at_ms INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  UNIQUE(tournament_key, account_id)
);

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

CREATE TABLE tournament_match_players (
  match_id TEXT NOT NULL REFERENCES tournament_matches(id),
  entry_id TEXT NOT NULL REFERENCES tournament_entries(id),
  account_id TEXT,
  player_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  PRIMARY KEY(match_id, entry_id),
  UNIQUE(match_id, player_id)
);

CREATE TABLE tournament_point_events (
  match_id TEXT NOT NULL REFERENCES tournament_matches(id),
  entry_id TEXT NOT NULL REFERENCES tournament_entries(id),
  rank INTEGER NOT NULL CHECK(rank BETWEEN 1 AND 4),
  knockouts INTEGER NOT NULL CHECK(knockouts BETWEEN 0 AND 3),
  points_units INTEGER NOT NULL CHECK(points_units >= 0),
  PRIMARY KEY(match_id, entry_id)
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

CREATE TABLE tournament_wait_reservations (
  account_id TEXT PRIMARY KEY NOT NULL,
  tournament_key TEXT NOT NULL REFERENCES tournaments(key),
  operation_id TEXT NOT NULL UNIQUE,
  lease_until_ms INTEGER NOT NULL,
  match_operation_id TEXT
);

CREATE TABLE "verification" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "identifier" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "expiresAt" INTEGER NOT NULL,
  "createdAt" INTEGER NOT NULL,
  "updatedAt" INTEGER NOT NULL
);

CREATE INDEX account_badge_awards_match ON account_badge_awards (account_id, match_id);
CREATE INDEX account_badge_notifications_pending
  ON account_badge_notifications (account_id, shown_at_ms, created_at_ms);
CREATE INDEX account_match_history_game_page
  ON account_match_history (account_id, game, mode, started_at_ms DESC, match_id DESC);
CREATE INDEX account_match_history_page
  ON account_match_history (account_id, mode, started_at_ms DESC, match_id DESC);
CREATE UNIQUE INDEX account_provider_identity_idx ON account (providerId, accountId);
CREATE INDEX "account_userId_idx" ON "account" ("userId");
CREATE INDEX announcement_targets_game ON announcement_lobby_targets(game, announcement_id);
CREATE INDEX announcements_public_published_on_order ON announcements(published, published_on DESC, created_at_ms DESC, id DESC);
CREATE INDEX announcements_published_on_order ON announcements(published_on DESC, created_at_ms DESC, id DESC);
CREATE INDEX deletion_rooms_by_room ON deletion_rooms (room_id, account_id);
CREATE UNIQUE INDEX `elo_rating_changes_account_id_game_rated_games_unique` ON `elo_rating_changes` (`account_id`,`game`,`rated_games`);
CREATE INDEX `elo_rating_pending_match` ON `elo_rating_pending` (`match_id`);
CREATE INDEX feedback_account ON feedback(account_id);
CREATE INDEX feedback_expiry ON feedback (expires_at_ms);
CREATE INDEX feedback_history_record ON feedback_history (feedback_id, at_ms);
CREATE INDEX feedback_limits_expiry ON feedback_limits(expires_at_ms);
CREATE INDEX feedback_newest ON feedback (ready, deleted, received_at_ms DESC, id DESC);
CREATE INDEX guest_sessions_account ON guest_sessions(account_id);
CREATE INDEX lobby_chat_messages_account ON lobby_chat_messages(account_id);
CREATE INDEX lobby_chat_messages_scope_time ON lobby_chat_messages(tournament_id,sent_at_ms DESC,id DESC);
CREATE INDEX lobby_chat_messages_time ON lobby_chat_messages(sent_at_ms DESC,id DESC);
CREATE INDEX lobby_rooms_order ON room_index(closed,status,updated_at_ms DESC,room_id DESC);
CREATE INDEX match_participant_accounts_account ON match_participant_accounts(account_id);
CREATE INDEX match_participant_accounts_pending ON match_participant_accounts(state, retry_at_ms);
CREATE INDEX matches_game_recent
  ON matches (game, started_at_ms DESC, id DESC);
CREATE INDEX matches_recent ON matches (started_at_ms DESC, id DESC);
CREATE INDEX notification_events_account ON notification_events(account_id,seq);
CREATE INDEX `privacy_room_players_by_room_player` ON `privacy_room_players` (`room_id`,`instance_id`,`player_id`);
CREATE INDEX registration_flows_account ON registration_flows(account_id);
CREATE INDEX registration_flows_expiry ON registration_flows(claim_until_ms);
CREATE INDEX registration_oauth_flow ON registration_oauth_states(registration_id);
CREATE INDEX reports_expiry ON reports (expires_at_ms);
CREATE INDEX reports_order ON reports (reported_at_ms DESC, id DESC);
CREATE INDEX reports_reporter_time ON reports (instance_id, reporter_hash, reported_at_ms DESC);
CREATE INDEX room_avatar_refs_key ON room_avatar_refs (avatar_key);
CREATE INDEX `room_index_closed_retention` ON `room_index` (coalesce("closed_at_ms", "closed_observed_at_ms", -1), `room_id`) WHERE closed = 1;
CREATE INDEX room_index_public_order
  ON room_index (closed, updated_at_ms DESC, room_id DESC);
CREATE INDEX "session_userId_idx" ON "session" ("userId");
CREATE UNIQUE INDEX `skill_rating_changes_account_id_game_rated_games_unique` ON `skill_rating_changes` (`account_id`,`game`,`rated_games`);
CREATE INDEX `skill_rating_pending_match` ON `skill_rating_pending` (`match_id`);
CREATE INDEX tournament_entries_list ON tournament_entries(tournament_key, entered_at_ms, id);
CREATE INDEX tournament_matches_pending ON tournament_matches(tournament_key, phase);
CREATE INDEX tournament_point_events_entry ON tournament_point_events(entry_id);
CREATE INDEX tournament_scores_ranking ON tournament_scores(tournament_key, points_units DESC, knockouts DESC);
CREATE INDEX tournaments_game_schedule ON tournaments(game,published,starts_at_ms,public_id);
CREATE INDEX tournaments_schedule ON tournaments(published, starts_at_ms, ends_at_ms);
CREATE UNIQUE INDEX user_public_profile_id_idx ON user(publicProfileId);
CREATE UNIQUE INDEX "user_username_normalized_idx" ON "user" (LOWER("username"));
CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier");

-- better-auth が直接書き込む表の退会フェンスを保持します。
CREATE TRIGGER privacy_fence_account BEFORE INSERT ON account
WHEN EXISTS (SELECT 1 FROM deleted_accounts WHERE id=NEW.userId)
BEGIN
  SELECT RAISE(IGNORE);
END;

CREATE TRIGGER privacy_fence_account_update BEFORE UPDATE ON account
WHEN EXISTS (SELECT 1 FROM deleted_accounts WHERE id=NEW.userId)
BEGIN
  SELECT RAISE(IGNORE);
END;

CREATE TRIGGER privacy_fence_session BEFORE INSERT ON session
WHEN EXISTS (SELECT 1 FROM deleted_accounts WHERE id = NEW.userId)
BEGIN
  SELECT RAISE(IGNORE);
END;

CREATE TRIGGER privacy_fence_user_update BEFORE UPDATE ON user
WHEN EXISTS (SELECT 1 FROM deleted_accounts WHERE id=NEW.id) AND (NEW.profileCompleted != 0 OR NEW.name != '退会したプレイヤー' OR NEW.avatarKey IS NOT NULL OR NEW.username IS NOT NULL OR NEW.publicProfileId IS NOT NULL)
BEGIN
  SELECT RAISE(IGNORE);
END;

INSERT INTO announcements (id, title, body, kind, published, created_at_ms, updated_at_ms, version, published_on)
VALUES ('feedback', '不具合やご意見を送れるようになりました', '登録なしで、不具合や機能のアイデアを送れます。画像も1枚添付できます。いただいた声を、これからの改善に役立てます。', 'feature', 1, 1791039600000, 1791039600000, 1, '2026-10-04');

INSERT INTO lobby_chat_settings (id, accepting)
VALUES (1, 1);

INSERT INTO notification_events (seq, kind, source_id, account_id, created_at_ms, payload_json, legacy)
VALUES (1, 'announcement', 'feedback', '', 1791039600000, '{}', 1);

INSERT INTO notification_metadata (key, value)
VALUES ('started_at_ms', CAST(unixepoch('subsec')*1000 AS INTEGER));
