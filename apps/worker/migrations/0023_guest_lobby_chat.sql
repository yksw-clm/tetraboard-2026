-- 統合で投稿の所有者が変わっても、ブラウザの送信者非表示設定を維持します。
ALTER TABLE lobby_chat_messages ADD COLUMN sender_public_id TEXT;
