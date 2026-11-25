ALTER TABLE "purchase_order_lines" ALTER COLUMN "item_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ALTER COLUMN "unit" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase_receipts" ALTER COLUMN "item_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD COLUMN "kind" text DEFAULT 'stock' NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD COLUMN "unit_label" text;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD COLUMN "nominal_code" text;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_kind_check" CHECK ("purchase_order_lines"."kind" in ('stock', 'non_stock'));--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_stock_check" CHECK ("purchase_order_lines"."kind" <> 'stock' or ("purchase_order_lines"."item_id" is not null and "purchase_order_lines"."unit" is not null));--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_non_stock_check" CHECK ("purchase_order_lines"."kind" <> 'non_stock' or ("purchase_order_lines"."description" is not null and "purchase_order_lines"."unit" is null));--> statement-breakpoint
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_stock_check" CHECK ("purchase_receipts"."item_id" is not null or ("purchase_receipts"."lot_id" is null and "purchase_receipts"."stock_movement_id" is null));