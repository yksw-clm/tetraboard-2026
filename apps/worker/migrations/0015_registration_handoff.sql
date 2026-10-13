-- 資格の原文は保存せず、OAuthと席・記録の進捗を独立して保持します。
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
  seat_state TEXT NOT NULL DEFAULT 'held'
);
CREATE INDEX registration_flows_account ON registration_flows(account_id);
CREATE INDEX registration_flows_expiry ON registration_flows(claim_until_ms);
CREATE TABLE registration_oauth_states (
  state TEXT PRIMARY KEY NOT NULL,
  registration_id TEXT NOT NULL REFERENCES registration_flows(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL
);
CREATE INDEX registration_oauth_flow ON registration_oauth_states(registration_id);
-- 削除受付以降に、遅延した認証が本人情報を復活させることを防ぎます。
CREATE TRIGGER registration_deleted_account_insert BEFORE INSERT ON registration_flows
WHEN NEW.account_id IS NOT NULL AND EXISTS (SELECT 1 FROM deleted_accounts WHERE id=NEW.account_id)
BEGIN SELECT RAISE(ABORT, 'registration account deleted'); END;
CREATE TRIGGER registration_deleted_account_update BEFORE UPDATE OF account_id ON registration_flows
WHEN NEW.account_id IS NOT NULL AND EXISTS (SELECT 1 FROM deleted_accounts WHERE id=NEW.account_id)
BEGIN SELECT RAISE(ABORT, 'registration account deleted'); END;
