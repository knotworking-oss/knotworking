CREATE TABLE "accounting_posting_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"posting_id" uuid NOT NULL,
	"attempt_id" uuid,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"evidence" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "accounting_postings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"company_id" text NOT NULL,
	"source_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"attempt_id" uuid,
	"attempts" integer DEFAULT 0 NOT NULL,
	"external_id" text,
	"receipt" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounting_postings_state_check" CHECK ("accounting_postings"."state" in ('queued', 'unknown', 'failed', 'posted'))
);
--> statement-breakpoint
ALTER TABLE "accounting_posting_events" ADD CONSTRAINT "accounting_posting_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_posting_events" ADD CONSTRAINT "accounting_posting_events_posting_id_accounting_postings_id_fk" FOREIGN KEY ("posting_id") REFERENCES "public"."accounting_postings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_postings" ADD CONSTRAINT "accounting_postings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounting_posting_events_history_idx" ON "accounting_posting_events" USING btree ("workspace_id","posting_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "accounting_postings_source_key" ON "accounting_postings" USING btree ("workspace_id","connection_id","kind","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "accounting_postings_external_key" ON "accounting_postings" USING btree ("workspace_id","connection_id","external_id");--> statement-breakpoint
CREATE INDEX "accounting_postings_queue_idx" ON "accounting_postings" USING btree ("workspace_id","state","created_at");