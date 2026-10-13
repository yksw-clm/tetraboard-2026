CREATE TABLE lobby_chat_settings (id INTEGER PRIMARY KEY CHECK(id=1), accepting INTEGER NOT NULL DEFAULT 1);
INSERT INTO lobby_chat_settings VALUES(1,1);
CREATE TABLE lobby_chat_senders (
 account_id TEXT PRIMARY KEY, public_id TEXT NOT NULL UNIQUE, last_sent_at_ms INTEGER NOT NULL DEFAULT 0, stopped INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE lobby_chat_messages (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL, body TEXT NOT NULL, sent_at_ms INTEGER NOT NULL, request_id TEXT NOT NULL, body_hash TEXT NOT NULL,
 UNIQUE(account_id,request_id)
);
CREATE INDEX lobby_chat_messages_time ON lobby_chat_messages(sent_at_ms DESC,id DESC);
CREATE INDEX lobby_chat_messages_account ON lobby_chat_messages(account_id);
CREATE TABLE lobby_chat_requests (
 account_id TEXT NOT NULL, request_id TEXT NOT NULL, message_id TEXT NOT NULL, body_hash TEXT NOT NULL, sent_at_ms INTEGER NOT NULL,
 PRIMARY KEY(account_id,request_id)
);
CREATE TABLE lobby_chat_reports (
 id TEXT PRIMARY KEY, message_id TEXT NOT NULL, sender_account_id TEXT, sender_public_id TEXT, sender_name TEXT NOT NULL,
 body TEXT NOT NULL, sent_at_ms INTEGER NOT NULL, reporter_account_id TEXT, reported_at_ms INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending', UNIQUE(message_id,reporter_account_id)
);
CREATE TRIGGER lobby_chat_accept AFTER INSERT ON lobby_chat_messages BEGIN
 UPDATE lobby_chat_senders SET last_sent_at_ms=NEW.sent_at_ms WHERE account_id=NEW.account_id;
 INSERT INTO lobby_chat_requests VALUES(NEW.account_id,NEW.request_id,NEW.id,NEW.body_hash,NEW.sent_at_ms);
 DELETE FROM lobby_chat_messages WHERE id IN (SELECT id FROM lobby_chat_messages ORDER BY sent_at_ms DESC,id DESC LIMIT -1 OFFSET 500);
END;
CREATE INDEX lobby_rooms_order ON room_index(closed,status,updated_at_ms DESC,room_id DESC);

ALTER TABLE analytics_daily ADD COLUMN general_lobby_views INTEGER NOT NULL DEFAULT 0;
ALTER TABLE analytics_daily ADD COLUMN general_lobby_dwell_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE analytics_daily ADD COLUMN human_completed INTEGER;
ALTER TABLE analytics_daily ADD COLUMN cpu_completed INTEGER;
