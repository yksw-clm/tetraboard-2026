CREATE TABLE `elo_rating_changes` (
	`game` text NOT NULL,
	`match_id` text NOT NULL,
	`account_id` text NOT NULL,
	`rating_before` real NOT NULL,
	`rating_after` real NOT NULL,
	`rated_games` integer NOT NULL,
	`human_games` integer NOT NULL,
	PRIMARY KEY(`match_id`, `account_id`),
	FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `elo_rating_changes_account_id_game_rated_games_unique` ON `elo_rating_changes` (`account_id`,`game`,`rated_games`);--> statement-breakpoint
CREATE TABLE `elo_rating_pending` (
	`game` text NOT NULL,
	`account_id` text NOT NULL,
	`match_id` text NOT NULL,
	`room_id` text,
	`instance_id` text,
	PRIMARY KEY(`game`, `account_id`),
	FOREIGN KEY (`account_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `elo_rating_pending_match` ON `elo_rating_pending` (`match_id`);--> statement-breakpoint
CREATE TABLE `skill_rating_changes` (
	`game` text NOT NULL,
	`match_id` text NOT NULL,
	`account_id` text NOT NULL,
	`mu_before` real NOT NULL,
	`sigma_before` real NOT NULL,
	`mu_after` real NOT NULL,
	`sigma_after` real NOT NULL,
	`rated_games` integer NOT NULL,
	`human_games` integer NOT NULL,
	PRIMARY KEY(`match_id`, `account_id`),
	FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skill_rating_changes_account_id_game_rated_games_unique` ON `skill_rating_changes` (`account_id`,`game`,`rated_games`);--> statement-breakpoint
CREATE TABLE `skill_rating_pending` (
	`game` text NOT NULL,
	`account_id` text NOT NULL,
	`match_id` text NOT NULL,
	`room_id` text,
	`instance_id` text,
	PRIMARY KEY(`game`, `account_id`),
	FOREIGN KEY (`account_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `skill_rating_pending_match` ON `skill_rating_pending` (`match_id`);--> statement-breakpoint
INSERT INTO `elo_rating_changes` (game, match_id, account_id, rating_before, rating_after, rated_games, human_games)
SELECT 'reversi', match_id, account_id, rating_before, rating_after, rated_games, human_games FROM `reversi_rating_changes`;--> statement-breakpoint
INSERT INTO `elo_rating_pending` (game, account_id, match_id, room_id, instance_id)
SELECT 'reversi', account_id, match_id, room_id, instance_id FROM `reversi_rating_pending`;--> statement-breakpoint
INSERT INTO `elo_rating_changes` (game, match_id, account_id, rating_before, rating_after, rated_games, human_games)
SELECT 'shogi', match_id, account_id, rating_before, rating_after, rated_games, human_games FROM `shogi_rating_changes`;--> statement-breakpoint
INSERT INTO `elo_rating_pending` (game, account_id, match_id, room_id, instance_id)
SELECT 'shogi', account_id, match_id, room_id, instance_id FROM `shogi_rating_pending`;--> statement-breakpoint
INSERT INTO `skill_rating_changes` (game, match_id, account_id, mu_before, sigma_before, mu_after, sigma_after, rated_games, human_games)
SELECT 'four-reversi', match_id, account_id, mu_before, sigma_before, mu_after, sigma_after, rated_games, human_games FROM `four_reversi_rating_changes`;--> statement-breakpoint
INSERT INTO `skill_rating_pending` (game, account_id, match_id, room_id, instance_id)
SELECT 'four-reversi', account_id, match_id, room_id, instance_id FROM `four_reversi_rating_pending`;--> statement-breakpoint
INSERT INTO `skill_rating_changes` (game, match_id, account_id, mu_before, sigma_before, mu_after, sigma_after, rated_games, human_games)
SELECT 'four-shogi', match_id, account_id, mu_before, sigma_before, mu_after, sigma_after, rated_games, human_games FROM `four_shogi_rating_changes`;--> statement-breakpoint
INSERT INTO `skill_rating_pending` (game, account_id, match_id, room_id, instance_id)
SELECT 'four-shogi', account_id, match_id, room_id, instance_id FROM `four_shogi_rating_pending`;--> statement-breakpoint
DROP TRIGGER `reversi_rating_account_deleted`;--> statement-breakpoint
DROP TRIGGER `reversi_rating_pending_account_deleted`;--> statement-breakpoint
DROP TRIGGER `shogi_rating_account_deleted`;--> statement-breakpoint
DROP TRIGGER `shogi_rating_pending_account_deleted`;--> statement-breakpoint
DROP TRIGGER `four_reversi_rating_account_deleted`;--> statement-breakpoint
DROP TRIGGER `four_reversi_rating_pending_account_deleted`;--> statement-breakpoint
DROP TRIGGER `four_shogi_rating_account_deleted`;--> statement-breakpoint
DROP TRIGGER `four_shogi_rating_pending_account_deleted`;--> statement-breakpoint
DROP TABLE `four_reversi_rating_changes`;--> statement-breakpoint
DROP TABLE `four_reversi_rating_pending`;--> statement-breakpoint
DROP TABLE `four_shogi_rating_changes`;--> statement-breakpoint
DROP TABLE `four_shogi_rating_pending`;--> statement-breakpoint
DROP TABLE `reversi_rating_changes`;--> statement-breakpoint
DROP TABLE `reversi_rating_pending`;--> statement-breakpoint
DROP TABLE `shogi_rating_changes`;--> statement-breakpoint
DROP TABLE `shogi_rating_pending`;
