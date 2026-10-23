ALTER TABLE tournaments ADD COLUMN chat_accepting INTEGER NOT NULL DEFAULT 1 CHECK(chat_accepting IN (0,1));
ALTER TABLE lobby_chat_messages ADD COLUMN tournament_id INTEGER REFERENCES tournaments(public_id);
ALTER TABLE lobby_chat_requests ADD COLUMN tournament_id INTEGER;
ALTER TABLE lobby_chat_reports ADD COLUMN tournament_id INTEGER;
CREATE INDEX lobby_chat_messages_scope_time ON lobby_chat_messages(tournament_id,sent_at_ms DESC,id DESC);
DROP TRIGGER lobby_chat_accept;
CREATE TRIGGER lobby_chat_accept AFTER INSERT ON lobby_chat_messages BEGIN
 UPDATE lobby_chat_senders SET last_sent_at_ms=NEW.sent_at_ms WHERE account_id=NEW.account_id;
 INSERT INTO lobby_chat_requests(account_id,request_id,message_id,body_hash,sent_at_ms,tournament_id)
 VALUES(NEW.account_id,NEW.request_id,NEW.id,NEW.body_hash,NEW.sent_at_ms,NEW.tournament_id);
 DELETE FROM lobby_chat_messages WHERE id IN (
  SELECT id FROM lobby_chat_messages WHERE tournament_id IS NEW.tournament_id
  ORDER BY sent_at_ms DESC,id DESC LIMIT -1 OFFSET 500
 );
END;
