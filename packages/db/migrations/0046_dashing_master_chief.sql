CREATE TABLE "sop_copies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"sop_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"copy_number" integer NOT NULL,
	"issued_to_user_id" uuid,
	"issued_to" text NOT NULL,
	"location" text,
	"status" text DEFAULT 'issued' NOT NULL,
	"issued_by" uuid,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"closed_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "sops" ADD COLUMN "ack_reminder_repeat_days" integer;--> statement-breakpoint
ALTER TABLE "quality_audit_programmes" ADD COLUMN "weekday" integer;--> statement-breakpoint
ALTER TABLE "sop_copies" ADD CONSTRAINT "sop_copies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sop_copies" ADD CONSTRAINT "sop_copies_sop_id_sops_id_fk" FOREIGN KEY ("sop_id") REFERENCES "public"."sops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sop_copies" ADD CONSTRAINT "sop_copies_version_id_sop_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."sop_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sop_copies" ADD CONSTRAINT "sop_copies_issued_to_user_id_users_id_fk" FOREIGN KEY ("issued_to_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sop_copies" ADD CONSTRAINT "sop_copies_issued_by_users_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sop_copies" ADD CONSTRAINT "sop_copies_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sop_copies_number_key" ON "sop_copies" USING btree ("version_id","copy_number");--> statement-breakpoint
CREATE INDEX "sop_copies_sop_idx" ON "sop_copies" USING btree ("workspace_id","sop_id");--> statement-breakpoint
CREATE INDEX "sop_copies_status_idx" ON "sop_copies" USING btree ("workspace_id","status");--> statement-breakpoint
ALTER TABLE "quality_audit_programmes" ADD CONSTRAINT "quality_audit_programmes_weekday_range" CHECK ("quality_audit_programmes"."weekday" is null or "quality_audit_programmes"."weekday" between 1 and 7);