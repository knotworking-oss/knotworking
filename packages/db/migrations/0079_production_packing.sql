CREATE TABLE "production_packing_checks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"details" jsonb NOT NULL,
	"passed" boolean NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"failure_action" text,
	"note" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recorded_by" uuid,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text
);
--> statement-breakpoint
CREATE TABLE "production_packing_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"label_id" uuid,
	"label_summary" jsonb,
	"specification_version_id" uuid,
	"specification_summary" jsonb,
	"nominal_quantity" numeric(12, 3),
	"expected_date_code" text NOT NULL,
	"expected_lot_code" text NOT NULL,
	"detector_required" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"note" text,
	"opened_by" uuid,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_by" uuid,
	"closed_at" timestamp with time zone,
	"packs_produced" integer,
	"reconciliation" jsonb,
	"variance_reason" text,
	"close_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "production_packing_checks" ADD CONSTRAINT "production_packing_checks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_packing_checks" ADD CONSTRAINT "production_packing_checks_run_id_production_packing_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."production_packing_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_packing_checks" ADD CONSTRAINT "production_packing_checks_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_packing_checks" ADD CONSTRAINT "production_packing_checks_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_packing_runs" ADD CONSTRAINT "production_packing_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_packing_runs" ADD CONSTRAINT "production_packing_runs_batch_id_production_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."production_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_packing_runs" ADD CONSTRAINT "production_packing_runs_label_id_product_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."product_labels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_packing_runs" ADD CONSTRAINT "production_packing_runs_specification_version_id_specification_versions_id_fk" FOREIGN KEY ("specification_version_id") REFERENCES "public"."specification_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_packing_runs" ADD CONSTRAINT "production_packing_runs_opened_by_users_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_packing_runs" ADD CONSTRAINT "production_packing_runs_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "production_packing_checks_run_idx" ON "production_packing_checks" USING btree ("run_id","checked_at");--> statement-breakpoint
CREATE INDEX "production_packing_runs_batch_idx" ON "production_packing_runs" USING btree ("batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "production_packing_runs_open_key" ON "production_packing_runs" USING btree ("batch_id") WHERE "production_packing_runs"."status" = 'open';