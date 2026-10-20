CREATE TABLE guest_sessions (
  token_hash TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  expires_at_ms INTEGER NOT NULL
);
CREATE INDEX guest_sessions_account ON guest_sessions(account_id);
CREATE TABLE guest_promotions (
  guest_id TEXT PRIMARY KEY NOT NULL,
  temporary_id TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL,
  session_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);
CREATE TRIGGER guest_promotion_fence BEFORE INSERT ON guest_promotions BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM user WHERE id=NEW.guest_id AND isAnonymous=1)
    OR NOT EXISTS(SELECT 1 FROM user WHERE id=NEW.temporary_id AND COALESCE(profileCompleted,0)=0)
    OR EXISTS(SELECT 1 FROM deleted_accounts WHERE id IN(NEW.guest_id,NEW.temporary_id))
    OR NOT EXISTS(SELECT 1 FROM guest_sessions WHERE account_id=NEW.guest_id AND token_hash=NEW.token_hash AND expires_at_ms>NEW.created_at_ms)
    OR NOT EXISTS(SELECT 1 FROM session WHERE id=NEW.session_id AND userId=NEW.temporary_id AND (CASE WHEN typeof(expiresAt) IN ('integer','real') THEN expiresAt ELSE unixepoch(expiresAt,'subsec')*1000 END)>NEW.created_at_ms)
    OR EXISTS(SELECT 1 FROM account_room_seats WHERE account_id IN(NEW.guest_id,NEW.temporary_id))
    OR EXISTS(SELECT 1 FROM tournament_wait_reservations WHERE account_id IN(NEW.guest_id,NEW.temporary_id))
    THEN RAISE(ABORT,'guest_promotion_conflict') END;
END;
CREATE TABLE guest_oauth_flows (
  state TEXT PRIMARY KEY NOT NULL,
  guest_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  guest_token_hash TEXT NOT NULL,
  provider TEXT NOT NULL,
  started_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  target_id TEXT,
  target_session_id TEXT,
  is_new_target INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE guest_account_merges (
  guest_id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL,
  merged_at_ms INTEGER NOT NULL,
  CHECK(guest_id != account_id)
);
-- 認証開始後の別タブ参加や同時統合も、記録を書き換える前に拒否します。
CREATE TRIGGER guest_merge_fence BEFORE INSERT ON guest_account_merges BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM user WHERE id=NEW.guest_id AND isAnonymous=1)
    OR NOT EXISTS(SELECT 1 FROM user WHERE id=NEW.account_id AND COALESCE(isAnonymous,0)=0)
    OR EXISTS(SELECT 1 FROM deleted_accounts WHERE id IN(NEW.guest_id,NEW.account_id))
    OR EXISTS(SELECT 1 FROM account_room_seats WHERE account_id IN(NEW.guest_id,NEW.account_id))
    OR EXISTS(SELECT 1 FROM tournament_wait_reservations WHERE account_id IN(NEW.guest_id,NEW.account_id))
    OR EXISTS(SELECT 1 FROM tournament_entries g JOIN tournament_entries a ON a.tournament_key=g.tournament_key
      WHERE g.account_id=NEW.guest_id AND a.account_id=NEW.account_id)
    OR EXISTS(SELECT 1 FROM account_match_history g JOIN account_match_history a ON a.match_id=g.match_id
      WHERE g.account_id=NEW.guest_id AND a.account_id=NEW.account_id)
    OR NOT EXISTS(SELECT 1 FROM guest_oauth_flows f JOIN guest_sessions g ON g.token_hash=f.guest_token_hash
      JOIN session s ON s.id=f.target_session_id AND s.userId=f.target_id
      WHERE f.guest_id=NEW.guest_id AND f.target_id=NEW.account_id AND f.expires_at_ms>NEW.merged_at_ms
        AND g.account_id=f.guest_id AND g.expires_at_ms>NEW.merged_at_ms
        AND (CASE WHEN typeof(s.expiresAt) IN ('integer','real') THEN s.expiresAt ELSE unixepoch(s.expiresAt,'subsec')*1000 END)>NEW.merged_at_ms)
    THEN RAISE(ABORT,'guest_merge_conflict') END;
END;
CREATE TRIGGER guest_merged_seat_fence BEFORE INSERT ON account_room_seats
WHEN EXISTS(SELECT 1 FROM guest_account_merges WHERE guest_id=NEW.account_id)
BEGIN SELECT RAISE(ABORT,'guest_merged'); END;
CREATE TRIGGER guest_merged_wait_fence BEFORE INSERT ON tournament_wait_reservations
WHEN EXISTS(SELECT 1 FROM guest_account_merges WHERE guest_id=NEW.account_id)
BEGIN SELECT RAISE(ABORT,'guest_merged'); END;
CREATE TRIGGER guest_merged_entry_fence BEFORE INSERT ON tournament_entries
WHEN EXISTS(SELECT 1 FROM guest_account_merges WHERE guest_id=NEW.account_id)
BEGIN SELECT RAISE(ABORT,'guest_merged'); END;
-- 統合より遅れて保存された棋譜にも、確定済みの本人対応を適用します。
CREATE TRIGGER guest_merged_match_insert AFTER INSERT ON matches
WHEN EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(NEW.record_json) THEN NEW.record_json ELSE '{}' END,'$.participants') p JOIN guest_account_merges g
  ON g.guest_id=json_extract(p.value,'$.accountId')) BEGIN
  UPDATE matches SET record_json=json_set(record_json,'$.participants',json((
    SELECT json_group_array(json(CASE WHEN g.account_id IS NOT NULL
      THEN json_set(p.value,'$.accountId',g.account_id) ELSE p.value END))
    FROM json_each(matches.record_json,'$.participants') p LEFT JOIN guest_account_merges g
      ON g.guest_id=json_extract(p.value,'$.accountId')))) WHERE id=NEW.id;
END;
CREATE TRIGGER guest_merged_history_insert AFTER INSERT ON account_match_history
WHEN EXISTS(SELECT 1 FROM guest_account_merges WHERE guest_id=NEW.account_id) BEGIN
  INSERT OR IGNORE INTO account_match_history(account_id,match_id,mode,started_at_ms,game)
    SELECT account_id,NEW.match_id,NEW.mode,NEW.started_at_ms,NEW.game FROM guest_account_merges WHERE guest_id=NEW.account_id;
  DELETE FROM account_match_history WHERE account_id=NEW.account_id AND match_id=NEW.match_id;
END;
CREATE TRIGGER guest_merged_upload_insert AFTER INSERT ON shogi_match_uploads
WHEN EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(NEW.record_json) THEN NEW.record_json ELSE '{}' END,'$.participants') p JOIN guest_account_merges g
  ON g.guest_id=json_extract(p.value,'$.accountId')) BEGIN
  UPDATE shogi_match_uploads SET record_json=json_set(record_json,'$.participants',json((
    SELECT json_group_array(json(CASE WHEN g.account_id IS NOT NULL
      THEN json_set(p.value,'$.accountId',g.account_id) ELSE p.value END))
    FROM json_each(shogi_match_uploads.record_json,'$.participants') p LEFT JOIN guest_account_merges g
      ON g.guest_id=json_extract(p.value,'$.accountId')))) WHERE id=NEW.id;
END;

ALTER TABLE analytics_participants ADD COLUMN is_guest INTEGER NOT NULL DEFAULT 0;

ALTER TABLE user ADD COLUMN guestRegisteredAt INTEGER;
