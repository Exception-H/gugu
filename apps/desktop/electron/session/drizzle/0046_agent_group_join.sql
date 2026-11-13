CREATE TABLE IF NOT EXISTS `agent_group_join_requests` (
  `id` text PRIMARY KEY NOT NULL,
  `operation_key` text NOT NULL,
  `session_id` text NOT NULL REFERENCES `sessions`(`id`) ON DELETE CASCADE,
  `chat_id` text NOT NULL,
  `target_agent_id` text NOT NULL,
  `actor_user_id` text NOT NULL,
  `initiator_agent_id` text NOT NULL,
  `as_task` integer DEFAULT false NOT NULL,
  `status` text NOT NULL CHECK (`status` IN ('pending','approved','applying','applied','denied','expired','withdrawn','failed')),
  `digest` text NOT NULL,
  `created_at` integer NOT NULL,
  `expires_at` integer NOT NULL,
  `decided_at` integer,
  `decided_by` text,
  `applied_at` integer,
  `result_status` text,
  `last_error` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_agent_group_join_key` ON `agent_group_join_requests` (`operation_key`,`created_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_agent_group_join_active` ON `agent_group_join_requests` (`operation_key`) WHERE `status` IN ('pending','approved','applying','applied');
