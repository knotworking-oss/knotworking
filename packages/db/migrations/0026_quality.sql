CREATE TABLE "quality_audits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"title" text NOT NULL,
	"scope" text,
	"planned_on" date NOT NULL,
	"auditor_user_id" uuid,
	"auditor_name" text,
	"status" text DEFAULT 'planned' NOT NULL,
	"completed_on" date,
	"summary" text,
	"completed_by" uuid,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancel_reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "quality_complaints" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"received_on" date NOT NULL,
	"source" text NOT NULL,
	"category" text NOT NULL,
	"severity" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"complainant_name" text,
	"complainant_contact" text,
	"customer" text,
	"item_id" uuid,
	"lot_id" uuid,
	"reported_lot_code" text,
	"description" text NOT NULL,
	"investigation" text,
	"root_cause" text,
	"response" text,
	"justified" boolean,
	"created_by" uuid,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"close_note" text,
	"reopened_at" timestamp with time zone,
	"reopen_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "quality_nonconformances" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"raised_on" date NOT NULL,
	"source" text NOT NULL,
	"severity" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"complaint_id" uuid,
	"audit_id" uuid,
	"item_id" uuid,
	"lot_id" uuid,
	"supplier_id" uuid,
	"containment" text,
	"root_cause" text,
	"corrective_action" text,
	"preventive_action" text,
	"owner_user_id" uuid,
	"due_on" date,
	"action_taken_at" timestamp with time zone,
	"created_by" uuid,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"verification_note" text,
	"reopened_at" timestamp with time zone,
	"reopen_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "quality_recall_tests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"conducted_on" date NOT NULL,
	"lot_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"scenario" text,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"duration_minutes" integer NOT NULL,
	"quantity_expected" numeric(18, 6) NOT NULL,
	"quantity_traced" numeric(18, 6) NOT NULL,
	"unit" text NOT NULL,
	"reconciled_percent" numeric(8, 1),
	"passed" boolean NOT NULL,
	"notes" text,
	"recorded_by" uuid,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "quality_audits" ADD CONSTRAINT "quality_audits_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_audits" ADD CONSTRAINT "quality_audits_auditor_user_id_users_id_fk" FOREIGN KEY ("auditor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_audits" ADD CONSTRAINT "quality_audits_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_audits" ADD CONSTRAINT "quality_audits_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_audits" ADD CONSTRAINT "quality_audits_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_complaints" ADD CONSTRAINT "quality_complaints_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_complaints" ADD CONSTRAINT "quality_complaints_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_complaints" ADD CONSTRAINT "quality_complaints_lot_id_stock_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."stock_lots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_complaints" ADD CONSTRAINT "quality_complaints_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_complaints" ADD CONSTRAINT "quality_complaints_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_nonconformances" ADD CONSTRAINT "quality_nonconformances_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_nonconformances" ADD CONSTRAINT "quality_nonconformances_complaint_id_quality_complaints_id_fk" FOREIGN KEY ("complaint_id") REFERENCES "public"."quality_complaints"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_nonconformances" ADD CONSTRAINT "quality_nonconformances_audit_id_quality_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "public"."quality_audits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_nonconformances" ADD CONSTRAINT "quality_nonconformances_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_nonconformances" ADD CONSTRAINT "quality_nonconformances_lot_id_stock_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."stock_lots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_nonconformances" ADD CONSTRAINT "quality_nonconformances_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_nonconformances" ADD CONSTRAINT "quality_nonconformances_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_nonconformances" ADD CONSTRAINT "quality_nonconformances_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_nonconformances" ADD CONSTRAINT "quality_nonconformances_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_recall_tests" ADD CONSTRAINT "quality_recall_tests_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_recall_tests" ADD CONSTRAINT "quality_recall_tests_lot_id_stock_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."stock_lots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_recall_tests" ADD CONSTRAINT "quality_recall_tests_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_recall_tests" ADD CONSTRAINT "quality_recall_tests_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "quality_audits_reference_key" ON "quality_audits" USING btree ("workspace_id","reference");--> statement-breakpoint
CREATE INDEX "quality_audits_planned_idx" ON "quality_audits" USING btree ("workspace_id","planned_on");--> statement-breakpoint
CREATE UNIQUE INDEX "quality_complaints_reference_key" ON "quality_complaints" USING btree ("workspace_id","reference");--> statement-breakpoint
CREATE INDEX "quality_complaints_received_idx" ON "quality_complaints" USING btree ("workspace_id","received_on");--> statement-breakpoint
CREATE INDEX "quality_complaints_item_idx" ON "quality_complaints" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "quality_complaints_lot_idx" ON "quality_complaints" USING btree ("lot_id");--> statement-breakpoint
CREATE UNIQUE INDEX "quality_nonconformances_reference_key" ON "quality_nonconformances" USING btree ("workspace_id","reference");--> statement-breakpoint
CREATE INDEX "quality_nonconformances_status_idx" ON "quality_nonconformances" USING btree ("workspace_id","status","due_on");--> statement-breakpoint
CREATE INDEX "quality_nonconformances_complaint_idx" ON "quality_nonconformances" USING btree ("complaint_id");--> statement-breakpoint
CREATE INDEX "quality_nonconformances_audit_idx" ON "quality_nonconformances" USING btree ("audit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "quality_recall_tests_reference_key" ON "quality_recall_tests" USING btree ("workspace_id","reference");--> statement-breakpoint
CREATE INDEX "quality_recall_tests_conducted_idx" ON "quality_recall_tests" USING btree ("workspace_id","conducted_on");--> statement-breakpoint
CREATE INDEX "quality_recall_tests_lot_idx" ON "quality_recall_tests" USING btree ("lot_id");