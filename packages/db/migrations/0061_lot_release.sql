CREATE TABLE "lot_release_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"require_passing_test" boolean DEFAULT false NOT NULL,
	"required_analytes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"require_approved_specification" boolean DEFAULT false NOT NULL,
	"require_ccp_reviewed" boolean DEFAULT false NOT NULL,
	"note" text,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "lot_releases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"lot_id" uuid NOT NULL,
	"released_by" uuid,
	"released_at" timestamp with time zone DEFAULT now() NOT NULL,
	"from_status" text NOT NULL,
	"note" text NOT NULL,
	"rule_version" integer,
	"rule" jsonb,
	"checks" jsonb NOT NULL,
	"exception" boolean DEFAULT false NOT NULL,
	"exception_reason" text,
	"exception_evidence" text
);
--> statement-breakpoint
ALTER TABLE "lot_release_rules" ADD CONSTRAINT "lot_release_rules_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lot_release_rules" ADD CONSTRAINT "lot_release_rules_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lot_release_rules" ADD CONSTRAINT "lot_release_rules_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lot_releases" ADD CONSTRAINT "lot_releases_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lot_releases" ADD CONSTRAINT "lot_releases_lot_id_stock_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."stock_lots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lot_releases" ADD CONSTRAINT "lot_releases_released_by_users_id_fk" FOREIGN KEY ("released_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "lot_release_rules_item_key" ON "lot_release_rules" USING btree ("item_id") WHERE "lot_release_rules"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "lot_releases_lot_idx" ON "lot_releases" USING btree ("lot_id","released_at");