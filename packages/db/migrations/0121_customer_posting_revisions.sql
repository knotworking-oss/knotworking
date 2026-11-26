ALTER TABLE "accounting_postings" ADD COLUMN "idempotency_key" uuid;
--> statement-breakpoint
ALTER TABLE "accounting_posting_events" ADD COLUMN "superseded_payload" jsonb;
