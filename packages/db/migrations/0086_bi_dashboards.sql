CREATE TABLE "bi_dashboard_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"dashboard_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"scope" text NOT NULL,
	"spec" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bi_dashboards" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"scope" text DEFAULT 'workspace' NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"spec" jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"audience" text DEFAULT 'workspace' NOT NULL,
	"audience_user_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"owner_id" uuid,
	"published_at" timestamp with time zone,
	"published_by" uuid,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "bi_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"dashboard_id" uuid,
	"dashboard_version" integer NOT NULL,
	"title" text NOT NULL,
	"as_at" date NOT NULL,
	"spec" jsonb NOT NULL,
	"results" jsonb NOT NULL,
	"catalogue_version" integer NOT NULL,
	"definitions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"taken_by" uuid,
	"taken_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bi_dashboard_versions" ADD CONSTRAINT "bi_dashboard_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bi_dashboard_versions" ADD CONSTRAINT "bi_dashboard_versions_dashboard_id_bi_dashboards_id_fk" FOREIGN KEY ("dashboard_id") REFERENCES "public"."bi_dashboards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bi_dashboard_versions" ADD CONSTRAINT "bi_dashboard_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bi_dashboards" ADD CONSTRAINT "bi_dashboards_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bi_dashboards" ADD CONSTRAINT "bi_dashboards_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bi_dashboards" ADD CONSTRAINT "bi_dashboards_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bi_dashboards" ADD CONSTRAINT "bi_dashboards_archived_by_users_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bi_snapshots" ADD CONSTRAINT "bi_snapshots_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bi_snapshots" ADD CONSTRAINT "bi_snapshots_dashboard_id_bi_dashboards_id_fk" FOREIGN KEY ("dashboard_id") REFERENCES "public"."bi_dashboards"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bi_snapshots" ADD CONSTRAINT "bi_snapshots_taken_by_users_id_fk" FOREIGN KEY ("taken_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bi_dashboard_versions_key" ON "bi_dashboard_versions" USING btree ("dashboard_id","version");--> statement-breakpoint
CREATE INDEX "bi_dashboards_workspace_idx" ON "bi_dashboards" USING btree ("workspace_id","scope","status");--> statement-breakpoint
CREATE INDEX "bi_snapshots_dashboard_idx" ON "bi_snapshots" USING btree ("workspace_id","dashboard_id","taken_at");