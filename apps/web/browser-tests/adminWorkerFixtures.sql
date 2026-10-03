-- 本番構成のローカルブラウザテストだけで使う、外部ログインに依存しない本人確認データです。
INSERT OR IGNORE INTO user (id, name, email, emailVerified, createdAt, updatedAt, username, profileCompleted, isTestUser)
VALUES ('browser-test-admin', '検証用管理者', 'admin@worker-browser.example.test', 1, '2026-10-02T15:00:00.000Z', '2026-10-02T15:00:00.000Z', 'browser_admin', 1, 1);
UPDATE user SET createdAt = '2026-10-02T15:00:00.000Z' WHERE id = 'browser-test-admin';
INSERT OR REPLACE INTO session (id, expiresAt, token, createdAt, updatedAt, userId)
VALUES ('browser-test-session', 4102444800000, 'local-browser-admin-test-token', 1790953200000, 1790953200000, 'browser-test-admin');
