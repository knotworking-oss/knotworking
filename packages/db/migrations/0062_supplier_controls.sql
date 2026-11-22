CREATE TABLE "supplier_questionnaires" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'sent' NOT NULL,
	"sent_on" date NOT NULL,
	"received_on" date,
	"valid_until" date,
	"notes" text,
	"review_note" text,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "supplier_risk_assessments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"item_id" uuid,
	"risk_level" text NOT NULL,
	"hazards" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rationale" text NOT NULL,
	"controls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"control_notes" text,
	"review_due_on" date NOT NULL,
	"assessed_by" uuid,
	"assessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "category" text DEFAULT 'goods' NOT NULL;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "service_type" text;--> statement-breakpoint
ALTER TABLE "supplier_questionnaires" ADD CONSTRAINT "supplier_questionnaires_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_questionnaires" ADD CONSTRAINT "supplier_questionnaires_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_questionnaires" ADD CONSTRAINT "supplier_questionnaires_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_questionnaires" ADD CONSTRAINT "supplier_questionnaires_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_risk_assessments" ADD CONSTRAINT "supplier_risk_assessments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_risk_assessments" ADD CONSTRAINT "supplier_risk_assessments_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_risk_assessments" ADD CONSTRAINT "supplier_risk_assessments_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_risk_assessments" ADD CONSTRAINT "supplier_risk_assessments_assessed_by_users_id_fk" FOREIGN KEY ("assessed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "supplier_questionnaires_supplier_idx" ON "supplier_questionnaires" USING btree ("supplier_id","sent_on");--> statement-breakpoint
CREATE INDEX "supplier_risk_assessments_supplier_idx" ON "supplier_risk_assessments" USING btree ("supplier_id","assessed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_risk_assessments_current_key" ON "supplier_risk_assessments" USING btree ("supplier_id",coalesce("item_id", '00000000-0000-0000-0000-000000000000'::uuid)) WHERE "supplier_risk_assessments"."superseded_at" is null and "supplier_risk_assessments"."deleted_at" is null;