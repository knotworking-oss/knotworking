CREATE TABLE "sales_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"action" text NOT NULL,
	"reason" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_external_references" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"system" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_fulfilments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"order_line_id" uuid NOT NULL,
	"despatch_line_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text
);
--> statement-breakpoint
CREATE TABLE "sales_order_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"item_id" uuid NOT NULL,
	"item_code" text NOT NULL,
	"item_name" text NOT NULL,
	"unit" text NOT NULL,
	"base_unit" text NOT NULL,
	"quantity" numeric(18, 4) NOT NULL,
	"base_quantity" numeric(18, 4) NOT NULL,
	"unit_price" numeric(18, 8) NOT NULL,
	"price_id" uuid,
	"due_on" date NOT NULL,
	"note" text NOT NULL,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sales_orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"customer_id" uuid NOT NULL,
	"delivery_site_id" uuid,
	"recipient" jsonb NOT NULL,
	"customer_reference" text DEFAULT '' NOT NULL,
	"currency" text NOT NULL,
	"valid_until" date,
	"terms" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"source_quote_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"signed_by" uuid,
	"signed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sales_prices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"unit" text NOT NULL,
	"currency" text NOT NULL,
	"unit_price" numeric(18, 8) NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"contract_reference" text NOT NULL,
	"terms" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" text
);
--> statement-breakpoint
ALTER TABLE "sales_events" ADD CONSTRAINT "sales_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_events" ADD CONSTRAINT "sales_events_order_id_sales_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."sales_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_events" ADD CONSTRAINT "sales_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_external_references" ADD CONSTRAINT "sales_external_references_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_external_references" ADD CONSTRAINT "sales_external_references_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_fulfilments" ADD CONSTRAINT "sales_fulfilments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_fulfilments" ADD CONSTRAINT "sales_fulfilments_order_id_sales_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."sales_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_fulfilments" ADD CONSTRAINT "sales_fulfilments_order_line_id_sales_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."sales_order_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_fulfilments" ADD CONSTRAINT "sales_fulfilments_despatch_line_id_despatch_lines_id_fk" FOREIGN KEY ("despatch_line_id") REFERENCES "public"."despatch_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_fulfilments" ADD CONSTRAINT "sales_fulfilments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_fulfilments" ADD CONSTRAINT "sales_fulfilments_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_order_id_sales_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."sales_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_price_id_sales_prices_id_fk" FOREIGN KEY ("price_id") REFERENCES "public"."sales_prices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_delivery_site_id_customer_delivery_sites_id_fk" FOREIGN KEY ("delivery_site_id") REFERENCES "public"."customer_delivery_sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_signed_by_users_id_fk" FOREIGN KEY ("signed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_prices" ADD CONSTRAINT "sales_prices_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_prices" ADD CONSTRAINT "sales_prices_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_prices" ADD CONSTRAINT "sales_prices_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_prices" ADD CONSTRAINT "sales_prices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_prices" ADD CONSTRAINT "sales_prices_archived_by_users_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sales_events_revision_key" ON "sales_events" USING btree ("workspace_id","order_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_external_refs_external_key" ON "sales_external_references" USING btree ("workspace_id","system","entity_type","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_external_refs_local_key" ON "sales_external_references" USING btree ("workspace_id","system","entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_fulfilments_despatch_key" ON "sales_fulfilments" USING btree ("workspace_id","despatch_line_id") WHERE "sales_fulfilments"."voided_at" is null;--> statement-breakpoint
CREATE INDEX "sales_fulfilments_order_idx" ON "sales_fulfilments" USING btree ("workspace_id","order_id");--> statement-breakpoint
CREATE INDEX "sales_order_lines_order_idx" ON "sales_order_lines" USING btree ("workspace_id","order_id");--> statement-breakpoint
CREATE INDEX "sales_order_lines_due_idx" ON "sales_order_lines" USING btree ("workspace_id","due_on");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_orders_reference_key" ON "sales_orders" USING btree ("workspace_id","reference");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_orders_source_quote_key" ON "sales_orders" USING btree ("workspace_id","source_quote_id");--> statement-breakpoint
CREATE INDEX "sales_orders_workspace_status_idx" ON "sales_orders" USING btree ("workspace_id","status","created_at");--> statement-breakpoint
CREATE INDEX "sales_prices_scope_idx" ON "sales_prices" USING btree ("workspace_id","customer_id","item_id","currency");