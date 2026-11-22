CREATE TABLE "costing_absorption_rates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"line_id" uuid,
	"effective_from" date NOT NULL,
	"labour_per_hour" numeric(14, 4) DEFAULT 0 NOT NULL,
	"labour_per_kg" numeric(14, 4) DEFAULT 0 NOT NULL,
	"overhead_per_hour" numeric(14, 4) DEFAULT 0 NOT NULL,
	"overhead_per_kg" numeric(14, 4) DEFAULT 0 NOT NULL,
	"note" text,
	"set_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "costing_period_closes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"period" text NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"status" text DEFAULT 'closed' NOT NULL,
	"summary" jsonb NOT NULL,
	"snapshot" jsonb NOT NULL,
	"note" text,
	"closed_by" uuid,
	"closed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reopened_by" uuid,
	"reopened_at" timestamp with time zone,
	"reopen_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "item_standard_costs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"effective_from" date NOT NULL,
	"cost" numeric(14, 4),
	"note" text,
	"set_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "currency" text DEFAULT 'GBP' NOT NULL;--> statement-breakpoint
ALTER TABLE "costing_absorption_rates" ADD CONSTRAINT "costing_absorption_rates_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "costing_absorption_rates" ADD CONSTRAINT "costing_absorption_rates_line_id_production_lines_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."production_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "costing_absorption_rates" ADD CONSTRAINT "costing_absorption_rates_set_by_users_id_fk" FOREIGN KEY ("set_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "costing_period_closes" ADD CONSTRAINT "costing_period_closes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "costing_period_closes" ADD CONSTRAINT "costing_period_closes_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "costing_period_closes" ADD CONSTRAINT "costing_period_closes_reopened_by_users_id_fk" FOREIGN KEY ("reopened_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_standard_costs" ADD CONSTRAINT "item_standard_costs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_standard_costs" ADD CONSTRAINT "item_standard_costs_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_standard_costs" ADD CONSTRAINT "item_standard_costs_set_by_users_id_fk" FOREIGN KEY ("set_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "costing_absorption_rates_line_key" ON "costing_absorption_rates" USING btree ("workspace_id","line_id","effective_from") WHERE "costing_absorption_rates"."line_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "costing_absorption_rates_default_key" ON "costing_absorption_rates" USING btree ("workspace_id","effective_from") WHERE "costing_absorption_rates"."line_id" is null;--> statement-breakpoint
CREATE INDEX "costing_period_closes_period_idx" ON "costing_period_closes" USING btree ("workspace_id","period","period_start");--> statement-breakpoint
CREATE UNIQUE INDEX "costing_period_closes_open_key" ON "costing_period_closes" USING btree ("workspace_id","period","period_start") WHERE "costing_period_closes"."status" = 'closed';--> statement-breakpoint
CREATE UNIQUE INDEX "item_standard_costs_item_date_key" ON "item_standard_costs" USING btree ("item_id","effective_from");