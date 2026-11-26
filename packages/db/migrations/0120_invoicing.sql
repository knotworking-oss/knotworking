CREATE TABLE "customer_document_claims" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"source_id" uuid NOT NULL,
	"order_line_id" uuid,
	"quantity" text,
	"released_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "customer_document_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"action" text NOT NULL,
	"reason" text NOT NULL,
	"actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"snapshot" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"customer" jsonb NOT NULL,
	"issuer" jsonb NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"serial" integer,
	"number" text,
	"date" date NOT NULL,
	"due_date" date,
	"currency" text NOT NULL,
	"source" text NOT NULL,
	"source_id" uuid,
	"source_reference" text,
	"credit_of" uuid,
	"credit_reason" text,
	"lines" jsonb NOT NULL,
	"net" text NOT NULL,
	"tax" text NOT NULL,
	"gross" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"issued_at" timestamp with time zone,
	CONSTRAINT "customer_documents_kind_check" CHECK ("customer_documents"."kind" in ('invoice', 'credit')),
	CONSTRAINT "customer_documents_status_check" CHECK ("customer_documents"."status" in ('draft', 'issued', 'discarded')),
	CONSTRAINT "customer_documents_issued_check" CHECK (("customer_documents"."status" = 'issued') = ("customer_documents"."serial" is not null and "customer_documents"."number" is not null and "customer_documents"."issued_at" is not null)),
	CONSTRAINT "customer_documents_credit_check" CHECK (("customer_documents"."kind" = 'credit' and "customer_documents"."credit_of" is not null and "customer_documents"."credit_reason" is not null and "customer_documents"."due_date" is null) or ("customer_documents"."kind" = 'invoice' and "customer_documents"."credit_of" is null and "customer_documents"."due_date" >= "customer_documents"."date" and "customer_documents"."due_date" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "customer_documents_workspace_id_key" ON "customer_documents" USING btree ("workspace_id","id");--> statement-breakpoint
ALTER TABLE "customer_document_claims" ADD CONSTRAINT "customer_document_claims_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_document_claims" ADD CONSTRAINT "customer_document_claims_document_fk" FOREIGN KEY ("workspace_id","document_id") REFERENCES "public"."customer_documents"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_document_events" ADD CONSTRAINT "customer_document_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_document_events" ADD CONSTRAINT "customer_document_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_document_events" ADD CONSTRAINT "customer_document_events_document_fk" FOREIGN KEY ("workspace_id","document_id") REFERENCES "public"."customer_documents"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_documents" ADD CONSTRAINT "customer_documents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_documents" ADD CONSTRAINT "customer_documents_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_documents" ADD CONSTRAINT "customer_documents_credit_fk" FOREIGN KEY ("workspace_id","credit_of") REFERENCES "public"."customer_documents"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_document_active_claim_key" ON "customer_document_claims" USING btree ("workspace_id","kind","source_id") WHERE "customer_document_claims"."released_at" is null;--> statement-breakpoint
CREATE INDEX "customer_document_claims_document_idx" ON "customer_document_claims" USING btree ("workspace_id","document_id");--> statement-breakpoint
CREATE INDEX "customer_document_claims_order_line_idx" ON "customer_document_claims" USING btree ("workspace_id","order_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_document_events_revision_key" ON "customer_document_events" USING btree ("workspace_id","document_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_documents_serial_key" ON "customer_documents" USING btree ("workspace_id","kind","serial");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_documents_number_key" ON "customer_documents" USING btree ("workspace_id","number");--> statement-breakpoint
CREATE INDEX "customer_documents_list_idx" ON "customer_documents" USING btree ("workspace_id","created_at");