ALTER TABLE "workspace_members" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD COLUMN "department" text;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD COLUMN "reports_to_user_id" uuid;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_reports_to_user_id_users_id_fk" FOREIGN KEY ("reports_to_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_members_reports_to_idx" ON "workspace_members" USING btree ("workspace_id","reports_to_user_id");