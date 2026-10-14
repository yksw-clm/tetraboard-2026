-- 棋譜本体の保存前も本人の引継ぎ受付を保持します。
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
CREATE INDEX match_participant_accounts_pending ON match_participant_accounts(state, retry_at_ms);
CREATE INDEX match_participant_accounts_account ON match_participant_accounts(account_id);
CREATE TRIGGER privacy_fence_match_claim_insert BEFORE INSERT ON match_participant_accounts
WHEN EXISTS(SELECT 1 FROM deleted_accounts WHERE id=NEW.account_id)
BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER privacy_fence_match_claim_update BEFORE UPDATE ON match_participant_accounts
WHEN EXISTS(SELECT 1 FROM deleted_accounts WHERE id=NEW.account_id)
BEGIN SELECT RAISE(IGNORE); END;

-- 退会済みの参加者は再取得させず、ゲストだった時の保存名も除去します。
CREATE TRIGGER privacy_retire_match_claims AFTER INSERT ON deleted_accounts BEGIN
  UPDATE match_participant_accounts SET state='retired',account_id=NULL WHERE account_id=NEW.id;
END;
CREATE TRIGGER privacy_scrub_retired_match_claim AFTER UPDATE OF state ON match_participant_accounts
WHEN NEW.state='retired' BEGIN
  UPDATE matches SET record_json=json_set(record_json,'$.participants',json((
    SELECT json_group_array(json(CASE WHEN json_extract(p.value,'$.id')=NEW.player_id
      THEN json_set(p.value,'$.name','退会したプレイヤー','$.accountId',NULL,'$.retired',json('true')) ELSE p.value END))
    FROM json_each(matches.record_json,'$.participants') p))) WHERE id=NEW.match_id;
  UPDATE shogi_match_uploads SET record_json=json_set(record_json,'$.participants',json((
    SELECT json_group_array(json(CASE WHEN json_extract(p.value,'$.id')=NEW.player_id
      THEN json_set(p.value,'$.name','退会したプレイヤー','$.accountId',NULL,'$.retired',json('true')) ELSE p.value END))
    FROM json_each(shogi_match_uploads.record_json,'$.participants') p))) WHERE id=NEW.match_id;
END;

-- 退会前に作られた保存待ち・転送途中の再送でも旧名を復活させません。
CREATE TRIGGER privacy_scrub_claimed_match_insert AFTER INSERT ON matches
WHEN EXISTS(SELECT 1 FROM match_participant_accounts c WHERE c.match_id=NEW.id AND c.state='retired') BEGIN
  UPDATE matches SET record_json=json_set(record_json,'$.participants',json((
    SELECT json_group_array(json(CASE WHEN EXISTS(SELECT 1 FROM match_participant_accounts c
      WHERE c.match_id=NEW.id AND c.player_id=json_extract(p.value,'$.id') AND c.state='retired')
      THEN json_set(p.value,'$.name','退会したプレイヤー','$.accountId',NULL,'$.retired',json('true')) ELSE p.value END))
    FROM json_each(matches.record_json,'$.participants') p))) WHERE id=NEW.id;
END;
CREATE TRIGGER privacy_scrub_claimed_match_update AFTER UPDATE OF record_json ON matches
WHEN EXISTS(SELECT 1 FROM match_participant_accounts c WHERE c.match_id=NEW.id AND c.state='retired') BEGIN
  UPDATE matches SET record_json=json_set(record_json,'$.participants',json((
    SELECT json_group_array(json(CASE WHEN EXISTS(SELECT 1 FROM match_participant_accounts c
      WHERE c.match_id=NEW.id AND c.player_id=json_extract(p.value,'$.id') AND c.state='retired')
      THEN json_set(p.value,'$.name','退会したプレイヤー','$.accountId',NULL,'$.retired',json('true')) ELSE p.value END))
    FROM json_each(matches.record_json,'$.participants') p))) WHERE id=NEW.id;
END;
CREATE TRIGGER privacy_scrub_claimed_upload_insert AFTER INSERT ON shogi_match_uploads
WHEN EXISTS(SELECT 1 FROM match_participant_accounts c WHERE c.match_id=NEW.id AND c.state='retired') BEGIN
  UPDATE shogi_match_uploads SET record_json=json_set(record_json,'$.participants',json((
    SELECT json_group_array(json(CASE WHEN EXISTS(SELECT 1 FROM match_participant_accounts c
      WHERE c.match_id=NEW.id AND c.player_id=json_extract(p.value,'$.id') AND c.state='retired')
      THEN json_set(p.value,'$.name','退会したプレイヤー','$.accountId',NULL,'$.retired',json('true')) ELSE p.value END))
    FROM json_each(shogi_match_uploads.record_json,'$.participants') p))) WHERE id=NEW.id;
END;
CREATE TRIGGER privacy_scrub_claimed_upload_update AFTER UPDATE OF record_json ON shogi_match_uploads
WHEN EXISTS(SELECT 1 FROM match_participant_accounts c WHERE c.match_id=NEW.id AND c.state='retired') BEGIN
  UPDATE shogi_match_uploads SET record_json=json_set(record_json,'$.participants',json((
    SELECT json_group_array(json(CASE WHEN EXISTS(SELECT 1 FROM match_participant_accounts c
      WHERE c.match_id=NEW.id AND c.player_id=json_extract(p.value,'$.id') AND c.state='retired')
      THEN json_set(p.value,'$.name','退会したプレイヤー','$.accountId',NULL,'$.retired',json('true')) ELSE p.value END))
    FROM json_each(shogi_match_uploads.record_json,'$.participants') p))) WHERE id=NEW.id;
END;
