CREATE TABLE `__new_notification_events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`source_id` text NOT NULL,
	`account_id` text DEFAULT '' NOT NULL,
	`created_at_ms` integer NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`legacy` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "notification_events_check_1" CHECK(kind IN ('announcement','tournament','badge','reply')),
	UNIQUE (`kind`,`source_id`,`account_id`)
);
--> statement-breakpoint
INSERT INTO `__new_notification_events`("seq", "kind", "source_id", "account_id", "created_at_ms", "payload_json", "legacy") SELECT "seq", "kind", "source_id", "account_id", "created_at_ms", "payload_json", "legacy" FROM `notification_events`;--> statement-breakpoint

-- 削除済みの最大発行番号を仮の行で確保する。DELETE 後も AUTOINCREMENT の採番上限は維持される。
INSERT INTO `__new_notification_events` (seq, kind, source_id, created_at_ms)
SELECT seq, 'reply', '', 0 FROM sqlite_sequence
WHERE name='notification_events' AND seq > COALESCE((SELECT MAX(seq) FROM notification_events), 0);
--> statement-breakpoint
DELETE FROM `__new_notification_events`
WHERE seq=(SELECT seq FROM sqlite_sequence WHERE name='notification_events')
  AND seq > COALESCE((SELECT MAX(seq) FROM notification_events), 0);
--> statement-breakpoint

-- D1 の外部キーを有効にしたまま、親の DROP が既読に CASCADE しないようにする。
CREATE TABLE `__saved_account_notification_reads` AS
SELECT account_id, notification_seq FROM `account_notification_reads`;
--> statement-breakpoint
DROP TABLE `account_notification_reads`;--> statement-breakpoint
DROP TABLE `notification_events`;--> statement-breakpoint
ALTER TABLE `__new_notification_events` RENAME TO `notification_events`;--> statement-breakpoint
CREATE INDEX `notification_events_account` ON `notification_events` (`account_id`,`seq`);--> statement-breakpoint
CREATE TABLE `account_notification_reads` (
  account_id TEXT NOT NULL,
  notification_seq INTEGER NOT NULL REFERENCES notification_events(seq) ON DELETE CASCADE,
  PRIMARY KEY(account_id,notification_seq)
);
--> statement-breakpoint
INSERT INTO `account_notification_reads` (account_id, notification_seq)
SELECT account_id, notification_seq FROM `__saved_account_notification_reads`;
--> statement-breakpoint
DROP TABLE `__saved_account_notification_reads`;
