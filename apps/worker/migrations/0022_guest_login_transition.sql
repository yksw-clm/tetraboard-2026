-- 登録者へログインした後のゲスト資格は、引き継ぎ確認にだけ使います。
ALTER TABLE guest_sessions ADD COLUMN registered_at_ms INTEGER;
