CREATE TABLE "custom_field_definitions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"target" text NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"team_id" uuid,
	"project_id" uuid,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sort_order" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "custom_field_definitions_single_scope" CHECK (num_nonnulls("custom_field_definitions"."team_id", "custom_field_definitions"."project_id") <= 1)
);
--> statement-breakpoint
CREATE TABLE "custom_field_values" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"task_id" uuid,
	"project_id" uuid,
	"text_value" text,
	"number_value" numeric,
	"date_value" date,
	"option_ids" jsonb,
	"person_id" uuid,
	"boolean_value" boolean,
	CONSTRAINT "custom_field_values_single_target" CHECK (num_nonnulls("custom_field_values"."task_id", "custom_field_values"."project_id") = 1),
	CONSTRAINT "custom_field_values_single_value" CHECK (num_nonnulls("custom_field_values"."text_value", "custom_field_values"."number_value", "custom_field_values"."date_value", "custom_field_values"."option_ids", "custom_field_values"."person_id", "custom_field_values"."boolean_value") = 1)
);
--> statement-breakpoint
ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_values" ADD CONSTRAINT "custom_field_values_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_values" ADD CONSTRAINT "custom_field_values_field_id_custom_field_definitions_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."custom_field_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_values" ADD CONSTRAINT "custom_field_values_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_values" ADD CONSTRAINT "custom_field_values_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_values" ADD CONSTRAINT "custom_field_values_person_id_users_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "custom_field_definitions_workspace_idx" ON "custom_field_definitions" USING btree ("workspace_id","target");--> statement-breakpoint
CREATE UNIQUE INDEX "custom_field_values_task_key" ON "custom_field_values" USING btree ("task_id","field_id");--> statement-breakpoint
CREATE UNIQUE INDEX "custom_field_values_project_key" ON "custom_field_values" USING btree ("project_id","field_id");--> statement-breakpoint
CREATE INDEX "custom_field_values_field_idx" ON "custom_field_values" USING btree ("field_id");