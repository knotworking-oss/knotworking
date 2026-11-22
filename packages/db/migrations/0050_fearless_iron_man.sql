ALTER TABLE "item_label_data" ADD COLUMN "polyols" numeric(10, 3);--> statement-breakpoint
ALTER TABLE "item_label_data" ADD COLUMN "erythritol" numeric(10, 3);--> statement-breakpoint
ALTER TABLE "item_label_data" ADD COLUMN "organic_acids" numeric(10, 3);--> statement-breakpoint
ALTER TABLE "item_label_data" ADD COLUMN "alcohol" numeric(10, 3);--> statement-breakpoint
ALTER TABLE "item_label_data" ADD COLUMN "micronutrients" jsonb;--> statement-breakpoint
ALTER TABLE "item_label_data" ADD COLUMN "retention" jsonb;--> statement-breakpoint
ALTER TABLE "product_labels" ADD COLUMN "gtin" text;