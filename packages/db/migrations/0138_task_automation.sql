CREATE TABLE "automation_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor_id" uuid,
	"name" text NOT NULL,
	"team_id" uuid,
	"trigger" text NOT NULL,
	"filter" jsonb,
	"actions" jsonb NOT NULL,
	"enabled" boolean NOT NULL,
	"revision" uuid NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "automation_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"revision" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"event_key" text NOT NULL,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"result" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "automation_webhooks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"secret_ciphertext" text NOT NULL,
	"events" text[] NOT NULL,
	"filter" jsonb,
	"enabled" boolean NOT NULL,
	"revision" uuid NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "task_recurrences" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source_task_id" uuid NOT NULL,
	"actor_id" uuid,
	"template" jsonb NOT NULL,
	"schedule" jsonb NOT NULL,
	"next_on" date NOT NULL,
	"previous_task_id" uuid,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"webhook_id" uuid NOT NULL,
	"revision" uuid NOT NULL,
	"event_key" text NOT NULL,
	"trigger" text NOT NULL,
	"body" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"next_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"response_status" integer
);
--> statement-breakpoint
ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_rule_id_automation_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."automation_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_webhooks" ADD CONSTRAINT "automation_webhooks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_recurrences" ADD CONSTRAINT "task_recurrences_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_recurrences" ADD CONSTRAINT "task_recurrences_source_task_id_tasks_id_fk" FOREIGN KEY ("source_task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_recurrences" ADD CONSTRAINT "task_recurrences_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_recurrences" ADD CONSTRAINT "task_recurrences_previous_task_id_tasks_id_fk" FOREIGN KEY ("previous_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_id_automation_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."automation_webhooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_rules_active_idx" ON "automation_rules" USING btree ("workspace_id","trigger") WHERE "automation_rules"."enabled" AND "automation_rules"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "automation_runs_rule_event_key" ON "automation_runs" USING btree ("rule_id","event_key","trigger");--> statement-breakpoint
CREATE INDEX "automation_runs_queue_idx" ON "automation_runs" USING btree ("id") WHERE "automation_runs"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "automation_runs_history_idx" ON "automation_runs" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_recurrences_source_key" ON "task_recurrences" USING btree ("workspace_id","source_task_id");--> statement-breakpoint
CREATE INDEX "task_recurrences_due_idx" ON "task_recurrences" USING btree ("next_on") WHERE "task_recurrences"."enabled";--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_event_key" ON "webhook_deliveries" USING btree ("webhook_id","event_key","trigger");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_queue_idx" ON "webhook_deliveries" USING btree ("next_at") WHERE "webhook_deliveries"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "webhook_deliveries_history_idx" ON "webhook_deliveries" USING btree ("workspace_id","id");