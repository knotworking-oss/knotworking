CREATE TABLE "supplier_control_settings" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"enforcement" text DEFAULT 'report' NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "lot_release_exception_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"lot_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"note" text NOT NULL,
	"reason" text NOT NULL,
	"evidence" text NOT NULL,
	"rule_version" integer,
	"checks" jsonb NOT NULL,
	"lot_status" text NOT NULL,
	"lot_status_changed_at" timestamp with time zone,
	"requested_by" uuid,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text
);
--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "approval_controls_override" jsonb;--> statement-breakpoint
ALTER TABLE "lot_releases" ADD COLUMN "exception_request_id" uuid;--> statement-breakpoint
ALTER TABLE "lot_releases" ADD COLUMN "exception_requested_by" uuid;--> statement-breakpoint
ALTER TABLE "lot_releases" ADD COLUMN "exception_self_approved" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "send_controls_override" jsonb;--> statement-breakpoint
ALTER TABLE "supplier_control_settings" ADD CONSTRAINT "supplier_control_settings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_control_settings" ADD CONSTRAINT "supplier_control_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lot_release_exception_requests" ADD CONSTRAINT "lot_release_exception_requests_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lot_release_exception_requests" ADD CONSTRAINT "lot_release_exception_requests_lot_id_stock_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."stock_lots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lot_release_exception_requests" ADD CONSTRAINT "lot_release_exception_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lot_release_exception_requests" ADD CONSTRAINT "lot_release_exception_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lot_release_exception_requests_lot_idx" ON "lot_release_exception_requests" USING btree ("lot_id","requested_at");--> statement-breakpoint
CREATE UNIQUE INDEX "lot_release_exception_requests_one_pending_key" ON "lot_release_exception_requests" USING btree ("lot_id") WHERE "lot_release_exception_requests"."status" = 'pending';--> statement-breakpoint
ALTER TABLE "lot_releases" ADD CONSTRAINT "lot_releases_exception_requested_by_users_id_fk" FOREIGN KEY ("exception_requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;