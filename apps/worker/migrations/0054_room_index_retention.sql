CREATE TABLE `room_index_deleted_revisions` (
	`room_id` text PRIMARY KEY NOT NULL,
	`deleted_through_revision` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `room_index_retention_cursor` (
	`id` integer PRIMARY KEY NOT NULL,
	`closed_sort_at_ms` integer NOT NULL,
	`room_id` text NOT NULL,
	CONSTRAINT "room_index_retention_singleton" CHECK(id = 1)
);
--> statement-breakpoint
ALTER TABLE `room_index` ADD `closed_at_ms` integer;
--> statement-breakpoint
ALTER TABLE `room_index` ADD `closed_observed_at_ms` integer;
--> statement-breakpoint
CREATE INDEX `room_index_closed_retention` ON `room_index` (coalesce("closed_at_ms", "closed_observed_at_ms", -1), `room_id`) WHERE closed = 1;
