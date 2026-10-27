-- 在室中の席の表示だけを索引へ保存し、旧行は閲覧時にDOから補完します。
ALTER TABLE room_index ADD COLUMN participants_json TEXT;

-- 退会受付と遅れて到着する索引の双方で、ホスト以外の画像も直ちに匿名化します。
CREATE TRIGGER privacy_hide_room_participants AFTER INSERT ON deleted_accounts BEGIN
  UPDATE room_index SET participants_json=(
    SELECT json_group_array(json(CASE WHEN (json_extract(p.value,'$.appearance.kind')='human' AND EXISTS (
        SELECT 1 FROM privacy_room_players r JOIN deleted_accounts d
          ON d.id=r.account_id OR EXISTS (
            SELECT 1 FROM guest_account_merges m WHERE m.guest_id=r.account_id AND m.account_id=d.id
          )
        WHERE r.room_id=room_index.room_id AND r.instance_id=room_index.instance_id
          AND r.player_id=json_extract(p.value,'$.playerId')
      ))
      THEN json_set(p.value,'$.appearance.avatarUrl',NULL,'$.appearance.retired',json('true'))
      ELSE p.value END)) FROM json_each(room_index.participants_json) p
  )
  WHERE participants_json IS NOT NULL
    AND EXISTS (SELECT 1 FROM json_each(room_index.participants_json) p WHERE (json_extract(p.value,'$.appearance.kind')='human' AND EXISTS (
        SELECT 1 FROM privacy_room_players r JOIN deleted_accounts d
          ON d.id=r.account_id OR EXISTS (
            SELECT 1 FROM guest_account_merges m WHERE m.guest_id=r.account_id AND m.account_id=d.id
          )
        WHERE r.room_id=room_index.room_id AND r.instance_id=room_index.instance_id
          AND r.player_id=json_extract(p.value,'$.playerId')
      )) AND (json_extract(p.value,'$.appearance.avatarUrl') IS NOT NULL
        OR COALESCE(json_extract(p.value,'$.appearance.retired'),0)<>1));
END;
CREATE TRIGGER privacy_scrub_room_participants_insert AFTER INSERT ON room_index
WHEN NEW.participants_json IS NOT NULL BEGIN
  UPDATE room_index SET participants_json=(
    SELECT json_group_array(json(CASE WHEN (json_extract(p.value,'$.appearance.kind')='human' AND EXISTS (
        SELECT 1 FROM privacy_room_players r JOIN deleted_accounts d
          ON d.id=r.account_id OR EXISTS (
            SELECT 1 FROM guest_account_merges m WHERE m.guest_id=r.account_id AND m.account_id=d.id
          )
        WHERE r.room_id=room_index.room_id AND r.instance_id=room_index.instance_id
          AND r.player_id=json_extract(p.value,'$.playerId')
      ))
      THEN json_set(p.value,'$.appearance.avatarUrl',NULL,'$.appearance.retired',json('true'))
      ELSE p.value END)) FROM json_each(room_index.participants_json) p
  )
  WHERE participants_json IS NOT NULL
    AND EXISTS (SELECT 1 FROM json_each(room_index.participants_json) p WHERE (json_extract(p.value,'$.appearance.kind')='human' AND EXISTS (
        SELECT 1 FROM privacy_room_players r JOIN deleted_accounts d
          ON d.id=r.account_id OR EXISTS (
            SELECT 1 FROM guest_account_merges m WHERE m.guest_id=r.account_id AND m.account_id=d.id
          )
        WHERE r.room_id=room_index.room_id AND r.instance_id=room_index.instance_id
          AND r.player_id=json_extract(p.value,'$.playerId')
      )) AND (json_extract(p.value,'$.appearance.avatarUrl') IS NOT NULL
        OR COALESCE(json_extract(p.value,'$.appearance.retired'),0)<>1)) AND room_id=NEW.room_id;
END;
CREATE TRIGGER privacy_scrub_room_participants_update AFTER UPDATE OF participants_json,instance_id ON room_index
WHEN NEW.participants_json IS NOT NULL BEGIN
  UPDATE room_index SET participants_json=(
    SELECT json_group_array(json(CASE WHEN (json_extract(p.value,'$.appearance.kind')='human' AND EXISTS (
        SELECT 1 FROM privacy_room_players r JOIN deleted_accounts d
          ON d.id=r.account_id OR EXISTS (
            SELECT 1 FROM guest_account_merges m WHERE m.guest_id=r.account_id AND m.account_id=d.id
          )
        WHERE r.room_id=room_index.room_id AND r.instance_id=room_index.instance_id
          AND r.player_id=json_extract(p.value,'$.playerId')
      ))
      THEN json_set(p.value,'$.appearance.avatarUrl',NULL,'$.appearance.retired',json('true'))
      ELSE p.value END)) FROM json_each(room_index.participants_json) p
  )
  WHERE participants_json IS NOT NULL
    AND EXISTS (SELECT 1 FROM json_each(room_index.participants_json) p WHERE (json_extract(p.value,'$.appearance.kind')='human' AND EXISTS (
        SELECT 1 FROM privacy_room_players r JOIN deleted_accounts d
          ON d.id=r.account_id OR EXISTS (
            SELECT 1 FROM guest_account_merges m WHERE m.guest_id=r.account_id AND m.account_id=d.id
          )
        WHERE r.room_id=room_index.room_id AND r.instance_id=room_index.instance_id
          AND r.player_id=json_extract(p.value,'$.playerId')
      )) AND (json_extract(p.value,'$.appearance.avatarUrl') IS NOT NULL
        OR COALESCE(json_extract(p.value,'$.appearance.retired'),0)<>1)) AND room_id=NEW.room_id;
END;
