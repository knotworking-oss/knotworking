CREATE TABLE "service_quote_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"quote_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"action" text NOT NULL,
	"reason" text NOT NULL,
	"actor_id" uuid,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_quotes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"recipient" jsonb NOT NULL,
	"title" text NOT NULL,
	"scope" text NOT NULL,
	"currency" text NOT NULL,
	"unit_price" numeric(18, 8) NOT NULL,
	"quoted_minutes" integer,
	"delivery_date" date,
	"status" text DEFAULT 'draft' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"project_id" uuid,
	"approved_minutes" integer,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_quotes_status_check" CHECK ("service_quotes"."status" in ('draft', 'issued', 'accepted', 'delivered', 'cancelled')),
	CONSTRAINT "service_quotes_amount_check" CHECK ("service_quotes"."unit_price" >= 0 and ("service_quotes"."quoted_minutes" is null or "service_quotes"."quoted_minutes" > 0)),
	CONSTRAINT "service_quotes_delivery_check" CHECK (("service_quotes"."status" = 'delivered') = ("service_quotes"."delivered_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "service_quote_events" ADD CONSTRAINT "service_quote_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_quote_events" ADD CONSTRAINT "service_quote_events_quote_id_service_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."service_quotes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_quote_events" ADD CONSTRAINT "service_quote_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_quotes" ADD CONSTRAINT "service_quotes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_quotes" ADD CONSTRAINT "service_quotes_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_quotes" ADD CONSTRAINT "service_quotes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "service_quote_events_revision_idx" ON "service_quote_events" USING btree ("workspace_id","quote_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "service_quotes_workspace_reference_idx" ON "service_quotes" USING btree ("workspace_id","reference");--> statement-breakpoint
CREATE INDEX "service_quotes_workspace_status_idx" ON "service_quotes" USING btree ("workspace_id","status","id");