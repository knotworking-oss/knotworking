CREATE TABLE "haccp_hazard_library" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"title" text NOT NULL,
	"step_name" text,
	"hazard_type" text NOT NULL,
	"description" text NOT NULL,
	"likelihood" integer NOT NULL,
	"severity" integer NOT NULL,
	"control_measure" text,
	"justification" text,
	"q1" boolean,
	"q2" boolean,
	"q3" boolean,
	"q4" boolean,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "haccp_plan_templates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"content" jsonb NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "haccp_plans" ADD COLUMN "hazard_review_interval_months" integer;--> statement-breakpoint
ALTER TABLE "haccp_plans" ADD COLUMN "hazard_review_due_on" date;--> statement-breakpoint
ALTER TABLE "haccp_plans" ADD COLUMN "hazard_reviewed_on" date;--> statement-breakpoint
ALTER TABLE "haccp_plans" ADD COLUMN "hazard_reviewed_by" uuid;--> statement-breakpoint
ALTER TABLE "haccp_plans" ADD COLUMN "hazard_review_note" text;--> statement-breakpoint
ALTER TABLE "haccp_hazard_library" ADD CONSTRAINT "haccp_hazard_library_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "haccp_hazard_library" ADD CONSTRAINT "haccp_hazard_library_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "haccp_hazard_library" ADD CONSTRAINT "haccp_hazard_library_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "haccp_plan_templates" ADD CONSTRAINT "haccp_plan_templates_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "haccp_plan_templates" ADD CONSTRAINT "haccp_plan_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "haccp_plan_templates" ADD CONSTRAINT "haccp_plan_templates_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "haccp_hazard_library_workspace_idx" ON "haccp_hazard_library" USING btree ("workspace_id","hazard_type");--> statement-breakpoint
CREATE INDEX "haccp_plan_templates_workspace_idx" ON "haccp_plan_templates" USING btree ("workspace_id");--> statement-breakpoint
ALTER TABLE "haccp_plans" ADD CONSTRAINT "haccp_plans_hazard_reviewed_by_users_id_fk" FOREIGN KEY ("hazard_reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;