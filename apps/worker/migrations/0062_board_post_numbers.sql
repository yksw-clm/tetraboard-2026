CREATE TABLE `board_post_numbers` (
	`number` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`post_id` text NOT NULL,
	FOREIGN KEY (`post_id`) REFERENCES `board_posts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "board_post_numbers_safe_integer" CHECK(number BETWEEN 1 AND 9007199254740991)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `board_post_numbers_post` ON `board_post_numbers` (`post_id`);
--> statement-breakpoint
INSERT INTO board_post_numbers (post_id)
SELECT id FROM board_posts WHERE parent_id IS NULL ORDER BY posted_at_ms, id;
--> statement-breakpoint
CREATE TRIGGER board_post_numbers_assign
AFTER INSERT ON board_posts
WHEN NEW.parent_id IS NULL
BEGIN
  INSERT INTO board_post_numbers (post_id) VALUES (NEW.id);
END;
