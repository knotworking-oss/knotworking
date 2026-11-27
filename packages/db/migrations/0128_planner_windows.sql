ALTER TABLE "teams" ADD COLUMN "features" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "closed_task_window_days" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_closed_task_window_days_check" CHECK ("workspaces"."closed_task_window_days" between 1 and 3650);
