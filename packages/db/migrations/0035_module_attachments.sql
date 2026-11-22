ALTER TABLE "attachments" ADD COLUMN "entity_type" text;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "entity_id" uuid;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "kind" text;--> statement-breakpoint
CREATE INDEX "attachments_entity_idx" ON "attachments" USING btree ("workspace_id","entity_type","entity_id");--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_one_parent" CHECK (("attachments"."task_id" is not null)::int + ("attachments"."document_id" is not null)::int + ("attachments"."entity_id" is not null)::int <= 1);