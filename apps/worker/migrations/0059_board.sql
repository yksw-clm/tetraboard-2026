CREATE TABLE `board_likes` (
	`post_id` text NOT NULL,
	`account_id` text NOT NULL,
	`liked_at_ms` integer NOT NULL,
	PRIMARY KEY(`post_id`, `account_id`),
	FOREIGN KEY (`post_id`) REFERENCES `board_posts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `board_likes_account` ON `board_likes` (`account_id`);--> statement-breakpoint
CREATE TABLE `board_posts` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`parent_id` text,
	`account_id` text,
	`body` text,
	`posted_at_ms` integer NOT NULL,
	`deleted_at_ms` integer,
	`deletion_reason` text,
	`match_id` text,
	`position` integer,
	`request_id` text NOT NULL,
	`body_hash` text NOT NULL,
	FOREIGN KEY (`parent_id`) REFERENCES `board_posts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "board_posts_game" CHECK(game_id IN ('four-reversi', 'four-shogi', 'reversi', 'shogi', 'gomoku', 'four-gomoku')),
	CONSTRAINT "board_posts_body" CHECK((deleted_at_ms IS NULL) = (body IS NOT NULL)),
	CONSTRAINT "board_posts_deletion_reason" CHECK(deletion_reason IN ('author', 'moderator', 'withdrawn')),
	CONSTRAINT "board_posts_attachment" CHECK((match_id IS NULL AND position IS NULL) OR (match_id IS NOT NULL AND position IS NOT NULL AND position >= 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `board_posts_account_request` ON `board_posts` (`account_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `board_posts_timeline` ON `board_posts` (`game_id`,"posted_at_ms" DESC,"id" DESC) WHERE "board_posts"."parent_id" IS NULL;--> statement-breakpoint
CREATE INDEX `board_posts_replies` ON `board_posts` (`parent_id`,`posted_at_ms`,`id`);--> statement-breakpoint
CREATE INDEX `board_posts_account` ON `board_posts` (`account_id`);--> statement-breakpoint
CREATE TABLE `board_senders` (
	`account_id` text PRIMARY KEY NOT NULL,
	`last_posted_at_ms` integer DEFAULT 0 NOT NULL,
	`stopped` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `board_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`accepting` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "board_settings_singleton" CHECK(id=1)
);
--> statement-breakpoint
INSERT INTO `board_settings` (`id`, `accepting`) VALUES (1, 0);
