CREATE TABLE "notification_sweeps" (
	"workspace_id" uuid NOT NULL,
	"module" text NOT NULL,
	"first_swept_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_sweeps_workspace_id_module_pk" PRIMARY KEY("workspace_id","module")
);
--> statement-breakpoint
ALTER TABLE "attendance_visits" ADD COLUMN "site_rules_hash" text;--> statement-breakpoint
ALTER TABLE "attendance_visits" ADD COLUMN "host_missing" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase_invoice_lines" ADD COLUMN "approved_match" jsonb;--> statement-breakpoint
ALTER TABLE "purchase_invoices" ADD COLUMN "approved_tolerances" jsonb;--> statement-breakpoint
ALTER TABLE "notification_sweeps" ADD CONSTRAINT "notification_sweeps_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;