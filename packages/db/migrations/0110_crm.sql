CREATE TABLE "crm_activities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"lead_id" uuid,
	"opportunity_id" uuid,
	"kind" text NOT NULL,
	"subject" text NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"due_on" date,
	"owner_id" uuid,
	"completed_at" timestamp with time zone,
	"completed_by" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_activities_subject_check" CHECK (("crm_activities"."lead_id" is null) <> ("crm_activities"."opportunity_id" is null)),
	CONSTRAINT "crm_activities_kind_check" CHECK ("crm_activities"."kind" in ('call', 'email', 'meeting', 'task', 'note'))
);
--> statement-breakpoint
CREATE TABLE "crm_leads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"name" text NOT NULL,
	"company" text DEFAULT '' NOT NULL,
	"email" text,
	"phone" text,
	"source" text,
	"notes" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"status_reason" text,
	"owner_id" uuid,
	"customer_id" uuid,
	"converted_at" timestamp with time zone,
	"converted_by" uuid,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_leads_status_check" CHECK ("crm_leads"."status" in ('new', 'contacted', 'qualified', 'converted', 'disqualified')),
	CONSTRAINT "crm_leads_converted_check" CHECK (("crm_leads"."status" = 'converted') = ("crm_leads"."customer_id" is not null and "crm_leads"."converted_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "crm_opportunities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"title" text NOT NULL,
	"customer_id" uuid,
	"lead_id" uuid,
	"stage_id" uuid NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"owner_id" uuid,
	"value" numeric(14, 2),
	"currency" text NOT NULL,
	"expected_close_date" date,
	"notes" text DEFAULT '' NOT NULL,
	"sales_quote_id" uuid,
	"service_quote_id" uuid,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"closed_reason" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_opportunities_status_check" CHECK ("crm_opportunities"."status" in ('open', 'won', 'lost')),
	CONSTRAINT "crm_opportunities_party_check" CHECK ("crm_opportunities"."customer_id" is not null or "crm_opportunities"."lead_id" is not null),
	CONSTRAINT "crm_opportunities_value_check" CHECK ("crm_opportunities"."value" is null or "crm_opportunities"."value" >= 0),
	CONSTRAINT "crm_opportunities_closed_check" CHECK (("crm_opportunities"."status" = 'open') = ("crm_opportunities"."closed_at" is null)),
	CONSTRAINT "crm_opportunities_one_quote_check" CHECK (num_nonnulls("crm_opportunities"."sales_quote_id", "crm_opportunities"."service_quote_id") <= 1)
);
--> statement-breakpoint
CREATE TABLE "crm_stages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"probability" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_stages_probability_check" CHECK ("crm_stages"."probability" between 0 and 100)
);
--> statement-breakpoint
ALTER TABLE "crm_activities" ADD CONSTRAINT "crm_activities_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_activities" ADD CONSTRAINT "crm_activities_lead_id_crm_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."crm_leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_activities" ADD CONSTRAINT "crm_activities_opportunity_id_crm_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."crm_opportunities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_activities" ADD CONSTRAINT "crm_activities_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_activities" ADD CONSTRAINT "crm_activities_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_activities" ADD CONSTRAINT "crm_activities_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_leads" ADD CONSTRAINT "crm_leads_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_leads" ADD CONSTRAINT "crm_leads_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_leads" ADD CONSTRAINT "crm_leads_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_leads" ADD CONSTRAINT "crm_leads_converted_by_users_id_fk" FOREIGN KEY ("converted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_leads" ADD CONSTRAINT "crm_leads_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_opportunities" ADD CONSTRAINT "crm_opportunities_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_opportunities" ADD CONSTRAINT "crm_opportunities_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_opportunities" ADD CONSTRAINT "crm_opportunities_lead_id_crm_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."crm_leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_opportunities" ADD CONSTRAINT "crm_opportunities_stage_id_crm_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."crm_stages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_opportunities" ADD CONSTRAINT "crm_opportunities_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_opportunities" ADD CONSTRAINT "crm_opportunities_sales_quote_id_sales_orders_id_fk" FOREIGN KEY ("sales_quote_id") REFERENCES "public"."sales_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_opportunities" ADD CONSTRAINT "crm_opportunities_service_quote_id_service_quotes_id_fk" FOREIGN KEY ("service_quote_id") REFERENCES "public"."service_quotes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_opportunities" ADD CONSTRAINT "crm_opportunities_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_opportunities" ADD CONSTRAINT "crm_opportunities_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_stages" ADD CONSTRAINT "crm_stages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "crm_activities_workspace_lead_idx" ON "crm_activities" USING btree ("workspace_id","lead_id");--> statement-breakpoint
CREATE INDEX "crm_activities_workspace_opportunity_idx" ON "crm_activities" USING btree ("workspace_id","opportunity_id");--> statement-breakpoint
CREATE INDEX "crm_activities_workspace_due_idx" ON "crm_activities" USING btree ("workspace_id","owner_id","due_on");--> statement-breakpoint
CREATE UNIQUE INDEX "crm_leads_workspace_reference_key" ON "crm_leads" USING btree ("workspace_id","reference");--> statement-breakpoint
CREATE INDEX "crm_leads_workspace_status_idx" ON "crm_leads" USING btree ("workspace_id","status","id");--> statement-breakpoint
CREATE INDEX "crm_leads_workspace_owner_idx" ON "crm_leads" USING btree ("workspace_id","owner_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "crm_opportunities_workspace_reference_key" ON "crm_opportunities" USING btree ("workspace_id","reference");--> statement-breakpoint
CREATE UNIQUE INDEX "crm_opportunities_sales_quote_key" ON "crm_opportunities" USING btree ("workspace_id","sales_quote_id") WHERE "crm_opportunities"."sales_quote_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "crm_opportunities_service_quote_key" ON "crm_opportunities" USING btree ("workspace_id","service_quote_id") WHERE "crm_opportunities"."service_quote_id" is not null;--> statement-breakpoint
CREATE INDEX "crm_opportunities_workspace_status_idx" ON "crm_opportunities" USING btree ("workspace_id","status","stage_id","id");--> statement-breakpoint
CREATE INDEX "crm_opportunities_workspace_customer_idx" ON "crm_opportunities" USING btree ("workspace_id","customer_id");--> statement-breakpoint
CREATE INDEX "crm_opportunities_workspace_lead_idx" ON "crm_opportunities" USING btree ("workspace_id","lead_id");--> statement-breakpoint
CREATE UNIQUE INDEX "crm_stages_workspace_name_key" ON "crm_stages" USING btree ("workspace_id",lower("name")) WHERE "crm_stages"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "crm_stages_workspace_position_idx" ON "crm_stages" USING btree ("workspace_id","position");