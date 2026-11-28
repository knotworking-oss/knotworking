CREATE TABLE "automation_pipeline_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"actor_id" uuid,
	"definition" jsonb NOT NULL,
	"key" text NOT NULL,
	"as_at" date NOT NULL,
	"outputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"recipient_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"lease_id" uuid,
	"lease_until" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_pipelines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"owner_id" uuid,
	"definition" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "automation_pipeline_runs" ADD CONSTRAINT "automation_pipeline_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_pipeline_runs" ADD CONSTRAINT "automation_pipeline_runs_pipeline_id_automation_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."automation_pipelines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_pipeline_runs" ADD CONSTRAINT "automation_pipeline_runs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_pipelines" ADD CONSTRAINT "automation_pipelines_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_pipelines" ADD CONSTRAINT "automation_pipelines_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "automation_pipeline_runs_occurrence_key" ON "automation_pipeline_runs" USING btree ("pipeline_id","key");--> statement-breakpoint
CREATE INDEX "automation_pipeline_runs_history_idx" ON "automation_pipeline_runs" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "automation_pipeline_runs_queue_idx" ON "automation_pipeline_runs" USING btree ("created_at") WHERE "automation_pipeline_runs"."finished_at" is null;--> statement-breakpoint
CREATE INDEX "automation_pipelines_workspace_idx" ON "automation_pipelines" USING btree ("workspace_id") WHERE "automation_pipelines"."deleted_at" is null;