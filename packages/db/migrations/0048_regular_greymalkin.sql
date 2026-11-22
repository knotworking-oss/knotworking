ALTER TABLE "api_token_action_log" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "token_actions" jsonb;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "max_order_value" numeric(18, 2);--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "replaces_id" uuid;