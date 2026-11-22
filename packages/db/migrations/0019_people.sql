CREATE TABLE "job_roles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "staff" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"staff_number" text NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"job_title" text,
	"department" text,
	"start_date" date,
	"end_date" date,
	"status" text DEFAULT 'active' NOT NULL,
	"payroll_reference" text,
	"user_id" uuid,
	"pin_hash" text,
	"pin_set_at" timestamp with time zone,
	"pin_set_by" uuid,
	"pin_failed_attempts" integer DEFAULT 0 NOT NULL,
	"pin_locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "staff_job_roles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"job_role_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "job_roles" ADD CONSTRAINT "job_roles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff" ADD CONSTRAINT "staff_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff" ADD CONSTRAINT "staff_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff" ADD CONSTRAINT "staff_pin_set_by_users_id_fk" FOREIGN KEY ("pin_set_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_job_roles" ADD CONSTRAINT "staff_job_roles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_job_roles" ADD CONSTRAINT "staff_job_roles_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_job_roles" ADD CONSTRAINT "staff_job_roles_job_role_id_job_roles_id_fk" FOREIGN KEY ("job_role_id") REFERENCES "public"."job_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "job_roles_workspace_name_key" ON "job_roles" USING btree ("workspace_id",lower("name")) WHERE "job_roles"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "staff_workspace_number_key" ON "staff" USING btree ("workspace_id","staff_number");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_workspace_user_key" ON "staff" USING btree ("workspace_id","user_id") WHERE "staff"."deleted_at" is null and "staff"."user_id" is not null;--> statement-breakpoint
CREATE INDEX "staff_workspace_name_idx" ON "staff" USING btree ("workspace_id","last_name","first_name");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_job_roles_key" ON "staff_job_roles" USING btree ("staff_id","job_role_id");--> statement-breakpoint
CREATE INDEX "staff_job_roles_role_idx" ON "staff_job_roles" USING btree ("job_role_id");