CREATE TABLE "purchase_credit_note_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"credit_note_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"kind" text NOT NULL,
	"invoice_line_id" uuid,
	"order_line_id" uuid,
	"reason" text,
	"quantity" numeric(14, 4) NOT NULL,
	"unit_price" numeric(18, 8) NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "purchase_credit_notes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"credit_note_number" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"credit_date" date NOT NULL,
	"vat" numeric(14, 4) DEFAULT 0 NOT NULL,
	"notes" text,
	"created_by" uuid,
	"approved_at" timestamp with time zone,
	"approved_by" uuid,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "purchase_order_emails" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"to_email" text NOT NULL,
	"subject" text NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"sent_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "purchase_supplier_prices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"unit" text NOT NULL,
	"unit_price" numeric(18, 8) NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "send_approved_by" uuid;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "send_approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "send_approved_value" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "send_approval_note" text;--> statement-breakpoint
ALTER TABLE "purchase_receipts" ADD COLUMN "over_delivery_reason" text;--> statement-breakpoint
ALTER TABLE "purchase_receipts" ADD COLUMN "voided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "purchase_receipts" ADD COLUMN "voided_by" uuid;--> statement-breakpoint
ALTER TABLE "purchase_receipts" ADD COLUMN "void_reason" text;--> statement-breakpoint
ALTER TABLE "purchasing_settings" ADD COLUMN "send_approval_threshold" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "purchasing_settings" ADD COLUMN "over_delivery_tolerance_percent" numeric(6, 2);--> statement-breakpoint
ALTER TABLE "purchase_credit_note_lines" ADD CONSTRAINT "purchase_credit_note_lines_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_credit_note_lines" ADD CONSTRAINT "purchase_credit_note_lines_credit_note_id_purchase_credit_notes_id_fk" FOREIGN KEY ("credit_note_id") REFERENCES "public"."purchase_credit_notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_credit_note_lines" ADD CONSTRAINT "purchase_credit_note_lines_invoice_line_id_purchase_invoice_lines_id_fk" FOREIGN KEY ("invoice_line_id") REFERENCES "public"."purchase_invoice_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_credit_note_lines" ADD CONSTRAINT "purchase_credit_note_lines_order_line_id_purchase_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."purchase_order_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_credit_notes" ADD CONSTRAINT "purchase_credit_notes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_credit_notes" ADD CONSTRAINT "purchase_credit_notes_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_credit_notes" ADD CONSTRAINT "purchase_credit_notes_invoice_id_purchase_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."purchase_invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_credit_notes" ADD CONSTRAINT "purchase_credit_notes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_credit_notes" ADD CONSTRAINT "purchase_credit_notes_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_credit_notes" ADD CONSTRAINT "purchase_credit_notes_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_emails" ADD CONSTRAINT "purchase_order_emails_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_emails" ADD CONSTRAINT "purchase_order_emails_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_emails" ADD CONSTRAINT "purchase_order_emails_sent_by_users_id_fk" FOREIGN KEY ("sent_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_supplier_prices" ADD CONSTRAINT "purchase_supplier_prices_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_supplier_prices" ADD CONSTRAINT "purchase_supplier_prices_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_supplier_prices" ADD CONSTRAINT "purchase_supplier_prices_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_supplier_prices" ADD CONSTRAINT "purchase_supplier_prices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "purchase_credit_note_lines_note_idx" ON "purchase_credit_note_lines" USING btree ("credit_note_id","line_no");--> statement-breakpoint
CREATE INDEX "purchase_credit_note_lines_order_line_idx" ON "purchase_credit_note_lines" USING btree ("order_line_id");--> statement-breakpoint
CREATE INDEX "purchase_credit_note_lines_invoice_line_idx" ON "purchase_credit_note_lines" USING btree ("invoice_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_credit_notes_number_key" ON "purchase_credit_notes" USING btree ("workspace_id","supplier_id",lower("credit_note_number")) WHERE "purchase_credit_notes"."deleted_at" is null and "purchase_credit_notes"."status" <> 'voided';--> statement-breakpoint
CREATE INDEX "purchase_credit_notes_invoice_idx" ON "purchase_credit_notes" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "purchase_credit_notes_status_idx" ON "purchase_credit_notes" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "purchase_order_emails_order_idx" ON "purchase_order_emails" USING btree ("purchase_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_supplier_prices_key" ON "purchase_supplier_prices" USING btree ("workspace_id","supplier_id","item_id","effective_from") WHERE "purchase_supplier_prices"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "purchase_supplier_prices_item_idx" ON "purchase_supplier_prices" USING btree ("workspace_id","item_id");--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_send_approved_by_users_id_fk" FOREIGN KEY ("send_approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;