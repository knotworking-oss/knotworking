CREATE TABLE "npd_projects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'brief' NOT NULL,
	"brief" text,
	"customer_name" text,
	"target_launch_on" date,
	"target_cost" numeric(14, 4),
	"target_shelf_life_days" integer,
	"storage" text,
	"claims" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"constraints" text,
	"output_item_id" uuid,
	"recipe_id" uuid,
	"signoffs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"launched_at" timestamp with time zone,
	"launched_by" uuid,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "npd_trials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"trial_number" integer NOT NULL,
	"kind" text NOT NULL,
	"held_on" date NOT NULL,
	"description" text NOT NULL,
	"recipe_version_id" uuid,
	"outcome" text NOT NULL,
	"findings" text,
	"achieved_shelf_life_days" integer,
	"storage" text,
	"recorded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "npd_projects" ADD CONSTRAINT "npd_projects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npd_projects" ADD CONSTRAINT "npd_projects_output_item_id_items_id_fk" FOREIGN KEY ("output_item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npd_projects" ADD CONSTRAINT "npd_projects_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npd_projects" ADD CONSTRAINT "npd_projects_launched_by_users_id_fk" FOREIGN KEY ("launched_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npd_projects" ADD CONSTRAINT "npd_projects_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npd_trials" ADD CONSTRAINT "npd_trials_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npd_trials" ADD CONSTRAINT "npd_trials_project_id_npd_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."npd_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npd_trials" ADD CONSTRAINT "npd_trials_recipe_version_id_recipe_versions_id_fk" FOREIGN KEY ("recipe_version_id") REFERENCES "public"."recipe_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npd_trials" ADD CONSTRAINT "npd_trials_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "npd_projects_code_key" ON "npd_projects" USING btree ("workspace_id",lower("code")) WHERE "npd_projects"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "npd_projects_status_idx" ON "npd_projects" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "npd_trials_number_key" ON "npd_trials" USING btree ("project_id","trial_number");