DROP INDEX "sales_orders_source_quote_key";--> statement-breakpoint
ALTER TABLE "sales_orders" ADD COLUMN "confirmed_at" timestamp with time zone;--> statement-breakpoint
-- Backfill: an order was confirmed when its first "confirm" event was recorded.
UPDATE "sales_orders" o SET "confirmed_at" = e."first_confirmed" FROM (SELECT "order_id", min("created_at") AS "first_confirmed" FROM "sales_events" WHERE "action" = 'confirm' GROUP BY "order_id") e WHERE e."order_id" = o."id";--> statement-breakpoint
CREATE UNIQUE INDEX "sales_orders_source_quote_key" ON "sales_orders" USING btree ("workspace_id","source_quote_id") WHERE "sales_orders"."status" <> 'cancelled' or "sales_orders"."confirmed_at" is not null;