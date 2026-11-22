CREATE TABLE "sop_targets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"sop_id" uuid NOT NULL,
	"job_role_id" uuid,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "sop_targets_one_kind" CHECK (("sop_targets"."job_role_id" is null) <> ("sop_targets"."user_id" is null))
);
--> statement-breakpoint
ALTER TABLE "sops" ADD COLUMN "ack_reminder_days" integer DEFAULT 14 NOT NULL;--> statement-breakpoint
ALTER TABLE "sop_targets" ADD CONSTRAINT "sop_targets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sop_targets" ADD CONSTRAINT "sop_targets_sop_id_sops_id_fk" FOREIGN KEY ("sop_id") REFERENCES "public"."sops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sop_targets" ADD CONSTRAINT "sop_targets_job_role_id_job_roles_id_fk" FOREIGN KEY ("job_role_id") REFERENCES "public"."job_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sop_targets" ADD CONSTRAINT "sop_targets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sop_targets_sop_idx" ON "sop_targets" USING btree ("sop_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sop_targets_role_key" ON "sop_targets" USING btree ("sop_id","job_role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sop_targets_user_key" ON "sop_targets" USING btree ("sop_id","user_id");