DROP INDEX "task_relations_blocking_blocked_key";--> statement-breakpoint
ALTER TABLE "task_relations" ADD COLUMN "kind" text DEFAULT 'blocks' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "task_relations_duplicate_key" ON "task_relations" USING btree ("blocking_task_id") WHERE "task_relations"."kind" = 'duplicate_of';--> statement-breakpoint
CREATE UNIQUE INDEX "task_relations_blocking_blocked_key" ON "task_relations" USING btree ("blocking_task_id","blocked_task_id","kind");--> statement-breakpoint
ALTER TABLE "task_relations" ADD CONSTRAINT "task_relations_kind" CHECK ("task_relations"."kind" in ('blocks', 'related', 'duplicate_of'));--> statement-breakpoint
ALTER TABLE "task_relations" ADD CONSTRAINT "task_relations_related_order" CHECK ("task_relations"."kind" <> 'related' or "task_relations"."blocking_task_id" < "task_relations"."blocked_task_id");