CREATE TABLE "quality_audit_programmes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"title" text NOT NULL,
	"scope" text,
	"interval_months" integer NOT NULL,
	"next_planned_on" date NOT NULL,
	"auditor_user_id" uuid,
	"auditor_name" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "quality_sales_volumes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"units" numeric(18, 2) NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "quality_audits" ADD COLUMN "programme_id" uuid;--> statement-breakpoint
ALTER TABLE "quality_nonconformances" ADD COLUMN "action_taken_by" uuid;--> statement-breakpoint
ALTER TABLE "quality_nonconformances" ADD COLUMN "supplier_reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "quality_nonconformances" ADD COLUMN "supplier_reviewed_by" uuid;--> statement-breakpoint
ALTER TABLE "quality_nonconformances" ADD COLUMN "supplier_review_status" text;--> statement-breakpoint
ALTER TABLE "quality_audit_programmes" ADD CONSTRAINT "quality_audit_programmes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_audit_programmes" ADD CONSTRAINT "quality_audit_programmes_auditor_user_id_users_id_fk" FOREIGN KEY ("auditor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_audit_programmes" ADD CONSTRAINT "quality_audit_programmes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_sales_volumes" ADD CONSTRAINT "quality_sales_volumes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_sales_volumes" ADD CONSTRAINT "quality_sales_volumes_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_sales_volumes" ADD CONSTRAINT "quality_sales_volumes_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quality_audit_programmes_workspace_idx" ON "quality_audit_programmes" USING btree ("workspace_id","active");--> statement-breakpoint
CREATE UNIQUE INDEX "quality_sales_volumes_key" ON "quality_sales_volumes" USING btree ("workspace_id","item_id","period_start");--> statement-breakpoint
ALTER TABLE "quality_audits" ADD CONSTRAINT "quality_audits_programme_id_quality_audit_programmes_id_fk" FOREIGN KEY ("programme_id") REFERENCES "public"."quality_audit_programmes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_nonconformances" ADD CONSTRAINT "quality_nonconformances_action_taken_by_users_id_fk" FOREIGN KEY ("action_taken_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_nonconformances" ADD CONSTRAINT "quality_nonconformances_supplier_reviewed_by_users_id_fk" FOREIGN KEY ("supplier_reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;