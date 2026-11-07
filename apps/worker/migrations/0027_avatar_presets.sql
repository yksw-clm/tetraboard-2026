-- アップロード画像と共用プリセットの参照を分離します。
ALTER TABLE user ADD COLUMN avatarPresetId TEXT;
ALTER TABLE account_room_seats ADD COLUMN avatar_preset_id TEXT;
