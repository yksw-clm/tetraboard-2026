-- 退会の受付・再認証・同意と、削除失敗の再開を保存します。
CREATE TABLE legal_consents (account_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE, version TEXT NOT NULL, accepted_at_ms INTEGER NOT NULL);
CREATE TABLE deletion_challenges (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, provider TEXT NOT NULL, created_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL, verified_at_ms INTEGER);
CREATE TABLE deleted_accounts (id TEXT PRIMARY KEY, requested_at_ms INTEGER NOT NULL, completed_at_ms INTEGER, receipt_hash TEXT NOT NULL UNIQUE, avatar_key TEXT, provider TEXT, revocation_token TEXT);
CREATE TABLE deletion_rooms (account_id TEXT NOT NULL REFERENCES deleted_accounts(id), room_id TEXT NOT NULL, PRIMARY KEY(account_id,room_id));
CREATE TABLE privacy_room_accounts (account_id TEXT NOT NULL, room_id TEXT NOT NULL, PRIMARY KEY(account_id,room_id));
CREATE TABLE analytics_daily (day TEXT NOT NULL, game TEXT NOT NULL, internal INTEGER NOT NULL, page_views INTEGER NOT NULL DEFAULT 0, dwell_ms INTEGER NOT NULL DEFAULT 0, started INTEGER NOT NULL DEFAULT 0, completed INTEGER NOT NULL DEFAULT 0, abandoned INTEGER NOT NULL DEFAULT 0, cpu_matches INTEGER NOT NULL DEFAULT 0, human_matches INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0, participation_ms INTEGER NOT NULL DEFAULT 0, singles INTEGER NOT NULL DEFAULT 0, doubles INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(day,game,internal));
CREATE TRIGGER privacy_fence_session BEFORE INSERT ON session
WHEN EXISTS (SELECT 1 FROM deleted_accounts WHERE id = NEW.userId) BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER privacy_fence_account_room_seats BEFORE INSERT ON account_room_seats
WHEN EXISTS (SELECT 1 FROM deleted_accounts WHERE id = NEW.account_id) BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER privacy_fence_privacy_room_accounts BEFORE INSERT ON privacy_room_accounts
WHEN EXISTS (SELECT 1 FROM deleted_accounts WHERE id = NEW.account_id) BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER privacy_fence_account_match_history BEFORE INSERT ON account_match_history
WHEN EXISTS (SELECT 1 FROM deleted_accounts WHERE id = NEW.account_id) BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER privacy_fence_account_badge_awards BEFORE INSERT ON account_badge_awards
WHEN EXISTS (SELECT 1 FROM deleted_accounts WHERE id = NEW.account_id) BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER privacy_fence_account_badge_notifications BEFORE INSERT ON account_badge_notifications
WHEN EXISTS (SELECT 1 FROM deleted_accounts WHERE id = NEW.account_id) BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER privacy_scrub_matches_insert AFTER INSERT ON matches WHEN EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(NEW.record_json) THEN NEW.record_json ELSE '{}' END,'$.participants') p JOIN deleted_accounts d ON d.id = json_extract(p.value,'$.accountId'))
BEGIN UPDATE matches SET record_json = json_set(record_json, '$.participants', json((SELECT json_group_array(json(CASE
      WHEN EXISTS (SELECT 1 FROM deleted_accounts d WHERE d.id = json_extract(p.value,'$.accountId'))
      THEN json_set(p.value,'$.name','退会したプレイヤー','$.accountId',NULL,'$.retired',json('true')) ELSE p.value END))
      FROM json_each(CASE WHEN json_valid(matches.record_json) THEN matches.record_json ELSE '{}' END,'$.participants') p))) WHERE id = NEW.id; END;
CREATE TRIGGER privacy_scrub_matches_update AFTER UPDATE OF record_json ON matches WHEN EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(NEW.record_json) THEN NEW.record_json ELSE '{}' END,'$.participants') p JOIN deleted_accounts d ON d.id = json_extract(p.value,'$.accountId'))
BEGIN UPDATE matches SET record_json = json_set(record_json, '$.participants', json((SELECT json_group_array(json(CASE
      WHEN EXISTS (SELECT 1 FROM deleted_accounts d WHERE d.id = json_extract(p.value,'$.accountId'))
      THEN json_set(p.value,'$.name','退会したプレイヤー','$.accountId',NULL,'$.retired',json('true')) ELSE p.value END))
      FROM json_each(CASE WHEN json_valid(matches.record_json) THEN matches.record_json ELSE '{}' END,'$.participants') p))) WHERE id = NEW.id; END;
CREATE TRIGGER privacy_scrub_shogi_match_uploads_insert AFTER INSERT ON shogi_match_uploads WHEN EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(NEW.record_json) THEN NEW.record_json ELSE '{}' END,'$.participants') p JOIN deleted_accounts d ON d.id = json_extract(p.value,'$.accountId'))
BEGIN UPDATE shogi_match_uploads SET record_json = json_set(record_json, '$.participants', json((SELECT json_group_array(json(CASE
      WHEN EXISTS (SELECT 1 FROM deleted_accounts d WHERE d.id = json_extract(p.value,'$.accountId'))
      THEN json_set(p.value,'$.name','退会したプレイヤー','$.accountId',NULL,'$.retired',json('true')) ELSE p.value END))
      FROM json_each(CASE WHEN json_valid(shogi_match_uploads.record_json) THEN shogi_match_uploads.record_json ELSE '{}' END,'$.participants') p))) WHERE id = NEW.id; END;
CREATE TRIGGER privacy_scrub_shogi_match_uploads_update AFTER UPDATE OF record_json ON shogi_match_uploads WHEN EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(NEW.record_json) THEN NEW.record_json ELSE '{}' END,'$.participants') p JOIN deleted_accounts d ON d.id = json_extract(p.value,'$.accountId'))
BEGIN UPDATE shogi_match_uploads SET record_json = json_set(record_json, '$.participants', json((SELECT json_group_array(json(CASE
      WHEN EXISTS (SELECT 1 FROM deleted_accounts d WHERE d.id = json_extract(p.value,'$.accountId'))
      THEN json_set(p.value,'$.name','退会したプレイヤー','$.accountId',NULL,'$.retired',json('true')) ELSE p.value END))
      FROM json_each(CASE WHEN json_valid(shogi_match_uploads.record_json) THEN shogi_match_uploads.record_json ELSE '{}' END,'$.participants') p))) WHERE id = NEW.id; END;
CREATE TRIGGER privacy_scrub_existing AFTER INSERT ON deleted_accounts BEGIN
UPDATE matches SET record_json = record_json WHERE EXISTS (
SELECT 1 FROM json_each(CASE WHEN json_valid(matches.record_json) THEN matches.record_json ELSE '{}' END,'$.participants') p WHERE json_extract(p.value,'$.accountId') = NEW.id);
UPDATE shogi_match_uploads SET record_json = record_json WHERE EXISTS (
SELECT 1 FROM json_each(CASE WHEN json_valid(shogi_match_uploads.record_json) THEN shogi_match_uploads.record_json ELSE '{}' END,'$.participants') p WHERE json_extract(p.value,'$.accountId') = NEW.id);
DELETE FROM account_match_history WHERE account_id = NEW.id;
DELETE FROM session WHERE userId = NEW.id;
UPDATE user SET name = '退会したプレイヤー', username = NULL, avatarKey = NULL, image = NULL, publicProfileId = NULL, profileCompleted = 0 WHERE id = NEW.id;
END;
ALTER TABLE deletion_challenges ADD COLUMN oauth_state TEXT;
ALTER TABLE deletion_challenges ADD COLUMN verified_session_id TEXT;
ALTER TABLE feedback ADD COLUMN account_id TEXT;
CREATE INDEX feedback_account ON feedback(account_id);
CREATE TRIGGER privacy_fence_feedback BEFORE INSERT ON feedback WHEN EXISTS(SELECT 1 FROM deleted_accounts WHERE id=NEW.account_id) BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER privacy_hide_feedback AFTER INSERT ON deleted_accounts BEGIN UPDATE feedback SET deleted=1 WHERE account_id=NEW.id; END;

CREATE TABLE deletion_images (account_id TEXT NOT NULL REFERENCES deleted_accounts(id), key TEXT NOT NULL, PRIMARY KEY(account_id,key));
CREATE TRIGGER privacy_fence_account BEFORE INSERT ON account WHEN EXISTS (SELECT 1 FROM deleted_accounts WHERE id=NEW.userId) BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER privacy_fence_account_update BEFORE UPDATE ON account WHEN EXISTS (SELECT 1 FROM deleted_accounts WHERE id=NEW.userId) BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER privacy_fence_user_update BEFORE UPDATE ON user WHEN EXISTS (SELECT 1 FROM deleted_accounts WHERE id=NEW.id) AND (NEW.profileCompleted != 0 OR NEW.name != '退会したプレイヤー' OR NEW.avatarKey IS NOT NULL OR NEW.username IS NOT NULL OR NEW.publicProfileId IS NOT NULL) BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER privacy_fence_pageview BEFORE INSERT ON analytics_pageviews WHEN EXISTS (SELECT 1 FROM deleted_accounts WHERE id=NEW.account_id) BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER privacy_scrub_analytics_participant AFTER INSERT ON analytics_participants WHEN EXISTS (SELECT 1 FROM deleted_accounts WHERE id=NEW.account_id) BEGIN UPDATE analytics_participants SET account_id=NULL, visitor_id=NULL WHERE match_id=NEW.match_id AND player_id=NEW.player_id; END;

-- ログインに不要な長期トークンは旧データからも除去します。
UPDATE account SET refreshToken=NULL, idToken=NULL;

-- 部屋番号の再利用後も、旧プロフィールと画像の削除先を発見します。
CREATE TABLE privacy_room_players (account_id TEXT NOT NULL, room_id TEXT NOT NULL, instance_id TEXT NOT NULL, player_id TEXT NOT NULL, avatar_key TEXT, PRIMARY KEY(account_id,room_id,instance_id,player_id));
INSERT INTO privacy_room_players SELECT account_id,room_id,instance_id,player_id,avatar_key FROM account_room_seats;
INSERT OR IGNORE INTO privacy_room_accounts SELECT account_id,room_id FROM account_room_seats;
CREATE TRIGGER privacy_fence_room_players BEFORE INSERT ON privacy_room_players WHEN EXISTS(SELECT 1 FROM deleted_accounts WHERE id=NEW.account_id) BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER privacy_hide_room_index AFTER INSERT ON deleted_accounts BEGIN
UPDATE room_index SET host_name='退会したプレイヤー',host_avatar_url=NULL,host_player_id=NULL WHERE EXISTS (SELECT 1 FROM privacy_room_players p WHERE p.account_id=NEW.id AND p.room_id=room_index.room_id AND p.instance_id=room_index.instance_id AND p.player_id=room_index.host_player_id);
INSERT OR IGNORE INTO deletion_images SELECT NEW.id,avatar_key FROM privacy_room_players WHERE account_id=NEW.id AND avatar_key IS NOT NULL;
END;
CREATE TRIGGER privacy_scrub_room_index_insert AFTER INSERT ON room_index WHEN EXISTS(SELECT 1 FROM privacy_room_players p JOIN deleted_accounts d ON d.id=p.account_id WHERE p.room_id=NEW.room_id AND p.instance_id=NEW.instance_id AND p.player_id=NEW.host_player_id) BEGIN UPDATE room_index SET host_name='退会したプレイヤー',host_avatar_url=NULL,host_player_id=NULL WHERE room_id=NEW.room_id; END;
CREATE TRIGGER privacy_scrub_room_index_update AFTER UPDATE OF host_name ON room_index WHEN EXISTS(SELECT 1 FROM privacy_room_players p JOIN deleted_accounts d ON d.id=p.account_id WHERE p.room_id=NEW.room_id AND p.instance_id=NEW.instance_id AND p.player_id=NEW.host_player_id) BEGIN UPDATE room_index SET host_name='退会したプレイヤー',host_avatar_url=NULL,host_player_id=NULL WHERE room_id=NEW.room_id; END;

CREATE TABLE oauth_legal_consents (state TEXT PRIMARY KEY,provider TEXT NOT NULL,version TEXT NOT NULL,created_at_ms INTEGER NOT NULL,expires_at_ms INTEGER NOT NULL);
ALTER TABLE deleted_accounts ADD COLUMN last_attempted_at_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE analytics_daily ADD COLUMN incomplete INTEGER NOT NULL DEFAULT 0;
CREATE TABLE analytics_disabled_participants (match_id TEXT NOT NULL, player_id TEXT NOT NULL, expires_at_ms INTEGER NOT NULL, PRIMARY KEY(match_id,player_id));
CREATE TRIGGER privacy_disabled_participant AFTER INSERT ON analytics_participants WHEN EXISTS (SELECT 1 FROM analytics_disabled_participants x WHERE x.match_id=NEW.match_id AND x.player_id=NEW.player_id) BEGIN UPDATE analytics_participants SET account_id=NULL,visitor_id=NULL WHERE match_id=NEW.match_id AND player_id=NEW.player_id; END;
CREATE TABLE analytics_deleted_registrations (day TEXT NOT NULL,internal INTEGER NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(day,internal));

CREATE TABLE deletion_flows (id TEXT PRIMARY KEY,account_id TEXT NOT NULL,expires_at_ms INTEGER NOT NULL);
CREATE TRIGGER privacy_challenge_limit BEFORE INSERT ON deletion_challenges WHEN (SELECT COUNT(*) FROM deletion_challenges WHERE account_id=NEW.account_id AND created_at_ms>NEW.created_at_ms-60000)>=5 BEGIN SELECT RAISE(IGNORE); END;
CREATE TABLE privacy_avatar_uploads (key TEXT PRIMARY KEY,account_id TEXT NOT NULL,started_at_ms INTEGER NOT NULL);
CREATE TRIGGER privacy_pending_images AFTER INSERT ON deleted_accounts BEGIN INSERT OR IGNORE INTO deletion_images SELECT NEW.id,key FROM privacy_avatar_uploads WHERE account_id=NEW.id; END;
