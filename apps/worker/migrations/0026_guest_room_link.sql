-- A room link may retain exactly the seat bound to its OAuth handoff.
ALTER TABLE registration_flows ADD COLUMN guest_account_id TEXT;
ALTER TABLE guest_oauth_flows ADD COLUMN room_registration_id TEXT;
CREATE TABLE guest_room_link_commits (
  registration_id TEXT PRIMARY KEY NOT NULL,
  guest_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  oauth_state TEXT NOT NULL,
  committed_at_ms INTEGER NOT NULL,
  FOREIGN KEY (registration_id) REFERENCES registration_flows(id) ON DELETE CASCADE
);
CREATE TRIGGER guest_room_link_commit_fence BEFORE INSERT ON guest_room_link_commits BEGIN
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1 FROM registration_flows r JOIN guest_oauth_flows f ON f.room_registration_id=r.id
    JOIN session s ON s.id=f.target_session_id AND s.userId=f.target_id
    WHERE r.id=NEW.registration_id AND r.guest_account_id=NEW.guest_id AND r.cancelled_at_ms IS NULL
      AND r.account_id=f.target_id AND r.session_id=f.target_session_id
      AND f.state=NEW.oauth_state AND f.guest_id=NEW.guest_id AND f.target_id=NEW.target_id
      AND f.expires_at_ms>NEW.committed_at_ms
      AND (CASE WHEN typeof(s.expiresAt) IN ('integer','real') THEN s.expiresAt ELSE unixepoch(s.expiresAt,'subsec')*1000 END)>NEW.committed_at_ms
  ) THEN RAISE(ABORT,'guest_merge_conflict') END;
END;

DROP TRIGGER guest_promotion_fence;
DROP TRIGGER guest_merge_fence;
CREATE TRIGGER guest_promotion_fence BEFORE INSERT ON guest_promotions BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM user WHERE id=NEW.guest_id AND isAnonymous=1)
    OR NOT EXISTS(SELECT 1 FROM user WHERE id=NEW.temporary_id AND COALESCE(profileCompleted,0)=0)
    OR EXISTS(SELECT 1 FROM deleted_accounts WHERE id IN(NEW.guest_id,NEW.temporary_id))
    OR NOT EXISTS(SELECT 1 FROM guest_sessions WHERE account_id=NEW.guest_id AND token_hash=NEW.token_hash AND expires_at_ms>NEW.created_at_ms)
    OR NOT EXISTS(SELECT 1 FROM session WHERE id=NEW.session_id AND userId=NEW.temporary_id AND (CASE WHEN typeof(expiresAt) IN ('integer','real') THEN expiresAt ELSE unixepoch(expiresAt,'subsec')*1000 END)>NEW.created_at_ms)
    OR EXISTS(SELECT 1 FROM account_room_seats WHERE account_id=NEW.temporary_id)
    OR EXISTS(SELECT 1 FROM account_room_seats seat WHERE seat.account_id=NEW.guest_id
      AND NOT EXISTS(SELECT 1 FROM guest_room_link_commits c
        JOIN registration_flows r ON r.id=c.registration_id JOIN guest_oauth_flows f ON f.state=c.oauth_state
        WHERE c.guest_id=seat.account_id AND r.guest_account_id=seat.account_id
          AND f.guest_id=NEW.guest_id AND f.target_id=NEW.temporary_id AND f.target_session_id=NEW.session_id AND f.expires_at_ms>NEW.created_at_ms
          AND r.room_id=seat.room_id AND r.instance_id=seat.instance_id AND r.player_id=seat.player_id
          AND r.cancelled_at_ms IS NULL AND r.hold_until_ms>NEW.created_at_ms))
    OR EXISTS(SELECT 1 FROM tournament_wait_reservations WHERE account_id IN(NEW.guest_id,NEW.temporary_id))
    THEN RAISE(ABORT,'guest_promotion_conflict') END;
END;
CREATE TRIGGER guest_merge_fence BEFORE INSERT ON guest_account_merges BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM user WHERE id=NEW.guest_id AND isAnonymous=1)
    OR NOT EXISTS(SELECT 1 FROM user WHERE id=NEW.account_id AND COALESCE(isAnonymous,0)=0)
    OR EXISTS(SELECT 1 FROM deleted_accounts WHERE id IN(NEW.guest_id,NEW.account_id))
    OR EXISTS(SELECT 1 FROM account_room_seats WHERE account_id=NEW.account_id)
    OR EXISTS(SELECT 1 FROM account_room_seats seat WHERE seat.account_id=NEW.guest_id
      AND NOT EXISTS(SELECT 1 FROM guest_room_link_commits c
        JOIN registration_flows r ON r.id=c.registration_id JOIN guest_oauth_flows f ON f.state=c.oauth_state
        WHERE c.guest_id=seat.account_id AND r.guest_account_id=seat.account_id
          AND f.guest_id=NEW.guest_id AND f.target_id=NEW.account_id AND f.expires_at_ms>NEW.merged_at_ms
          AND r.room_id=seat.room_id AND r.instance_id=seat.instance_id AND r.player_id=seat.player_id
          AND r.cancelled_at_ms IS NULL AND r.hold_until_ms>NEW.merged_at_ms))
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
