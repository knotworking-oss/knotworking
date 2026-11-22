CREATE TABLE "demand_history" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"line_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"customer" text,
	"action" text NOT NULL,
	"previous_quantity" numeric(18, 4),
	"quantity" numeric(18, 4),
	"note" text,
	"source" text NOT NULL,
	"import_id" uuid,
	"actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "demand_imports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"file_name" text,
	"row_count" integer NOT NULL,
	"created_count" integer DEFAULT 0 NOT NULL,
	"updated_count" integer DEFAULT 0 NOT NULL,
	"removed_count" integer DEFAULT 0 NOT NULL,
	"unchanged_count" integer DEFAULT 0 NOT NULL,
	"actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "demand_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"customer" text,
	"quantity" numeric(18, 4) NOT NULL,
	"note" text,
	"source" text NOT NULL,
	"external_ref" text,
	"import_id" uuid,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "demand_history" ADD CONSTRAINT "demand_history_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demand_history" ADD CONSTRAINT "demand_history_line_id_demand_lines_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."demand_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demand_history" ADD CONSTRAINT "demand_history_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demand_history" ADD CONSTRAINT "demand_history_import_id_demand_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."demand_imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demand_history" ADD CONSTRAINT "demand_history_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demand_imports" ADD CONSTRAINT "demand_imports_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demand_imports" ADD CONSTRAINT "demand_imports_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demand_lines" ADD CONSTRAINT "demand_lines_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demand_lines" ADD CONSTRAINT "demand_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demand_lines" ADD CONSTRAINT "demand_lines_import_id_demand_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."demand_imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demand_lines" ADD CONSTRAINT "demand_lines_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demand_lines" ADD CONSTRAINT "demand_lines_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "demand_history_line_idx" ON "demand_history" USING btree ("line_id","created_at");--> statement-breakpoint
CREATE INDEX "demand_history_workspace_item_idx" ON "demand_history" USING btree ("workspace_id","item_id","period_start");--> statement-breakpoint
CREATE INDEX "demand_imports_workspace_created_idx" ON "demand_imports" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "demand_lines_key" ON "demand_lines" USING btree ("workspace_id","item_id","period_start",lower(coalesce("customer", ''))) WHERE "demand_lines"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "demand_lines_workspace_period_idx" ON "demand_lines" USING btree ("workspace_id","period_start");--> statement-breakpoint
CREATE INDEX "demand_lines_item_period_idx" ON "demand_lines" USING btree ("item_id","period_start");