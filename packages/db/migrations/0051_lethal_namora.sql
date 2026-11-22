CREATE TABLE "production_non_working_days" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"date" date NOT NULL,
	"line_id" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "production_reservations" ADD COLUMN "location_id" uuid;--> statement-breakpoint
ALTER TABLE "production_reservations" ADD COLUMN "expires_on" date;--> statement-breakpoint
ALTER TABLE "production_non_working_days" ADD CONSTRAINT "production_non_working_days_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_non_working_days" ADD CONSTRAINT "production_non_working_days_line_id_production_lines_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."production_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "production_non_working_days_key" ON "production_non_working_days" USING btree ("workspace_id","date",coalesce("line_id", '00000000-0000-0000-0000-000000000000'::uuid)) WHERE "production_non_working_days"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "production_non_working_days_date_idx" ON "production_non_working_days" USING btree ("workspace_id","date");--> statement-breakpoint
ALTER TABLE "production_reservations" ADD CONSTRAINT "production_reservations_location_id_stock_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."stock_locations"("id") ON DELETE no action ON UPDATE no action;