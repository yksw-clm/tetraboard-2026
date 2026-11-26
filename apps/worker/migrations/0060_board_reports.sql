CREATE TABLE `board_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`post_id` text NOT NULL,
	`game_id` text NOT NULL,
	`parent_id` text,
	`author_account_id` text,
	`author_name` text NOT NULL,
	`body` text NOT NULL,
	`posted_at_ms` integer NOT NULL,
	`reason` text NOT NULL,
	`reporter_account_id` text,
	`reported_at_ms` integer NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	CONSTRAINT "board_reports_reason" CHECK(reason IN ('harassment', 'abuse', 'spam', 'personalInfo', 'other')),
	CONSTRAINT "board_reports_status" CHECK(status IN ('open', 'resolved'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `board_reports_post_reporter` ON `board_reports` (`post_id`,`reporter_account_id`);--> statement-breakpoint
CREATE INDEX `board_reports_reported` ON `board_reports` ("reported_at_ms" DESC,"id" DESC);--> statement-breakpoint
CREATE INDEX `board_reports_reporter_reported` ON `board_reports` (`reporter_account_id`,`reported_at_ms`);--> statement-breakpoint
CREATE INDEX `board_reports_author` ON `board_reports` (`author_account_id`);