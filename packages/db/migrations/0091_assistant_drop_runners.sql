-- The runner-based assistant is replaced by member API keys (docs/assistant.md). Before dropping
-- runners: end replies that were waiting on one, discard their queued jobs, and revoke the API
-- tokens runners were paired with so no live credential outlives its runner.
UPDATE "assistant_messages" SET "status" = 'error', "error" = 'The assistant was upgraded before this reply finished.', "updated_at" = now() WHERE "status" = 'running';--> statement-breakpoint
DELETE FROM "assistant_turns";--> statement-breakpoint
UPDATE "api_tokens" SET "revoked_at" = now() WHERE "revoked_at" IS NULL AND "id" IN (SELECT "api_token_id" FROM "assistant_runners" WHERE "api_token_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "assistant_runners" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "assistant_runners" CASCADE;--> statement-breakpoint
ALTER TABLE "assistant_conversations" DROP CONSTRAINT IF EXISTS "assistant_conversations_runner_id_assistant_runners_id_fk";
--> statement-breakpoint
ALTER TABLE "assistant_turns" DROP CONSTRAINT IF EXISTS "assistant_turns_runner_id_assistant_runners_id_fk";
--> statement-breakpoint
DROP INDEX IF EXISTS "assistant_turns_runner_idx";--> statement-breakpoint
ALTER TABLE "assistant_conversations" DROP COLUMN "provider_session_id";--> statement-breakpoint
ALTER TABLE "assistant_conversations" DROP COLUMN "runner_id";--> statement-breakpoint
ALTER TABLE "assistant_turns" DROP COLUMN "runner_id";--> statement-breakpoint
ALTER TABLE "assistant_turns" DROP COLUMN "job";--> statement-breakpoint
ALTER TABLE "assistant_turns" DROP COLUMN "taken_at";--> statement-breakpoint
ALTER TABLE "assistant_turns" DROP COLUMN "cancel_pending";