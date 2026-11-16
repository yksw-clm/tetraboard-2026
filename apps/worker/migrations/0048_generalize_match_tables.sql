ALTER TABLE `shogi_match_formations` RENAME TO `four_shogi_formation_usages`;--> statement-breakpoint
ALTER TABLE `shogi_match_chunks` RENAME TO `match_event_chunks`;--> statement-breakpoint
ALTER TABLE `shogi_match_uploads` RENAME TO `match_uploads`;--> statement-breakpoint
DROP TRIGGER `guest_merged_upload_insert`;--> statement-breakpoint
CREATE TRIGGER guest_merged_upload_insert AFTER INSERT ON match_uploads
WHEN EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(NEW.record_json) THEN NEW.record_json ELSE '{}' END,'$.participants') p JOIN guest_account_merges g
  ON g.guest_id=json_extract(p.value,'$.accountId')) BEGIN
  UPDATE match_uploads SET record_json=json_set(record_json,'$.participants',json((
    SELECT json_group_array(json(CASE WHEN g.account_id IS NOT NULL
      THEN json_set(p.value,'$.accountId',g.account_id) ELSE p.value END))
    FROM json_each(match_uploads.record_json,'$.participants') p LEFT JOIN guest_account_merges g
      ON g.guest_id=json_extract(p.value,'$.accountId')))) WHERE id=NEW.id;
END;--> statement-breakpoint
DROP TRIGGER `privacy_scrub_claimed_upload_insert`;--> statement-breakpoint
CREATE TRIGGER privacy_scrub_claimed_upload_insert AFTER INSERT ON match_uploads
WHEN EXISTS(SELECT 1 FROM match_participant_accounts c WHERE c.match_id=NEW.id AND c.state='retired') BEGIN
  UPDATE match_uploads SET record_json=json_set(record_json,'$.participants',json((
    SELECT json_group_array(json(CASE WHEN EXISTS(SELECT 1 FROM match_participant_accounts c
      WHERE c.match_id=NEW.id AND c.player_id=json_extract(p.value,'$.id') AND c.state='retired')
      THEN json_set(p.value,'$.name','退会したプレイヤー','$.accountId',NULL,'$.retired',json('true')) ELSE p.value END))
    FROM json_each(match_uploads.record_json,'$.participants') p))) WHERE id=NEW.id;
END;--> statement-breakpoint
DROP TRIGGER `privacy_scrub_claimed_upload_update`;--> statement-breakpoint
CREATE TRIGGER privacy_scrub_claimed_upload_update AFTER UPDATE OF record_json ON match_uploads
WHEN EXISTS(SELECT 1 FROM match_participant_accounts c WHERE c.match_id=NEW.id AND c.state='retired') BEGIN
  UPDATE match_uploads SET record_json=json_set(record_json,'$.participants',json((
    SELECT json_group_array(json(CASE WHEN EXISTS(SELECT 1 FROM match_participant_accounts c
      WHERE c.match_id=NEW.id AND c.player_id=json_extract(p.value,'$.id') AND c.state='retired')
      THEN json_set(p.value,'$.name','退会したプレイヤー','$.accountId',NULL,'$.retired',json('true')) ELSE p.value END))
    FROM json_each(match_uploads.record_json,'$.participants') p))) WHERE id=NEW.id;
END;--> statement-breakpoint
DROP TRIGGER `privacy_scrub_existing`;--> statement-breakpoint
CREATE TRIGGER privacy_scrub_existing AFTER INSERT ON deleted_accounts BEGIN
UPDATE matches SET record_json = record_json WHERE EXISTS (
SELECT 1 FROM json_each(CASE WHEN json_valid(matches.record_json) THEN matches.record_json ELSE '{}' END,'$.participants') p WHERE json_extract(p.value,'$.accountId') = NEW.id);
UPDATE match_uploads SET record_json = record_json WHERE EXISTS (
SELECT 1 FROM json_each(CASE WHEN json_valid(match_uploads.record_json) THEN match_uploads.record_json ELSE '{}' END,'$.participants') p WHERE json_extract(p.value,'$.accountId') = NEW.id);
DELETE FROM account_match_history WHERE account_id = NEW.id;
DELETE FROM session WHERE userId = NEW.id;
UPDATE user SET name = '退会したプレイヤー', username = NULL, avatarKey = NULL, image = NULL, publicProfileId = NULL, profileCompleted = 0 WHERE id = NEW.id;
END;--> statement-breakpoint
DROP TRIGGER `privacy_scrub_retired_match_claim`;--> statement-breakpoint
CREATE TRIGGER privacy_scrub_retired_match_claim AFTER UPDATE OF state ON match_participant_accounts
WHEN NEW.state='retired' BEGIN
  UPDATE matches SET record_json=json_set(record_json,'$.participants',json((
    SELECT json_group_array(json(CASE WHEN json_extract(p.value,'$.id')=NEW.player_id
      THEN json_set(p.value,'$.name','退会したプレイヤー','$.accountId',NULL,'$.retired',json('true')) ELSE p.value END))
    FROM json_each(matches.record_json,'$.participants') p))) WHERE id=NEW.match_id;
  UPDATE match_uploads SET record_json=json_set(record_json,'$.participants',json((
    SELECT json_group_array(json(CASE WHEN json_extract(p.value,'$.id')=NEW.player_id
      THEN json_set(p.value,'$.name','退会したプレイヤー','$.accountId',NULL,'$.retired',json('true')) ELSE p.value END))
    FROM json_each(match_uploads.record_json,'$.participants') p))) WHERE id=NEW.match_id;
END;--> statement-breakpoint
DROP TRIGGER `privacy_scrub_shogi_match_uploads_insert`;--> statement-breakpoint
CREATE TRIGGER privacy_scrub_shogi_match_uploads_insert AFTER INSERT ON match_uploads WHEN EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(NEW.record_json) THEN NEW.record_json ELSE '{}' END,'$.participants') p JOIN deleted_accounts d ON d.id = json_extract(p.value,'$.accountId'))
BEGIN UPDATE match_uploads SET record_json = json_set(record_json, '$.participants', json((SELECT json_group_array(json(CASE
      WHEN EXISTS (SELECT 1 FROM deleted_accounts d WHERE d.id = json_extract(p.value,'$.accountId'))
      THEN json_set(p.value,'$.name','退会したプレイヤー','$.accountId',NULL,'$.retired',json('true')) ELSE p.value END))
      FROM json_each(CASE WHEN json_valid(match_uploads.record_json) THEN match_uploads.record_json ELSE '{}' END,'$.participants') p))) WHERE id = NEW.id; END;--> statement-breakpoint
DROP TRIGGER `privacy_scrub_shogi_match_uploads_update`;--> statement-breakpoint
CREATE TRIGGER privacy_scrub_shogi_match_uploads_update AFTER UPDATE OF record_json ON match_uploads WHEN EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(NEW.record_json) THEN NEW.record_json ELSE '{}' END,'$.participants') p JOIN deleted_accounts d ON d.id = json_extract(p.value,'$.accountId'))
BEGIN UPDATE match_uploads SET record_json = json_set(record_json, '$.participants', json((SELECT json_group_array(json(CASE
      WHEN EXISTS (SELECT 1 FROM deleted_accounts d WHERE d.id = json_extract(p.value,'$.accountId'))
      THEN json_set(p.value,'$.name','退会したプレイヤー','$.accountId',NULL,'$.retired',json('true')) ELSE p.value END))
      FROM json_each(CASE WHEN json_valid(match_uploads.record_json) THEN match_uploads.record_json ELSE '{}' END,'$.participants') p))) WHERE id = NEW.id; END;--> statement-breakpoint
