DROP INDEX "product_labels_number_key";--> statement-breakpoint
DROP INDEX "product_labels_one_draft_key";--> statement-breakpoint
DROP INDEX "product_labels_one_approved_key";--> statement-breakpoint
ALTER TABLE "product_labels" ADD COLUMN "variant" text DEFAULT 'Standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "product_labels" ADD COLUMN "volatile_item_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "product_labels" ADD COLUMN "energy_method" text DEFAULT 'declared' NOT NULL;--> statement-breakpoint
ALTER TABLE "product_labels" ADD COLUMN "negligible_as_zero" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "product_labels" ADD COLUMN "portion_size" numeric(10, 3);--> statement-breakpoint
ALTER TABLE "product_labels" ADD COLUMN "portion_label" text;--> statement-breakpoint
ALTER TABLE "product_labels" ADD COLUMN "last_edited_by" uuid;--> statement-breakpoint
ALTER TABLE "product_labels" ADD CONSTRAINT "product_labels_last_edited_by_users_id_fk" FOREIGN KEY ("last_edited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_labels_number_key" ON "product_labels" USING btree ("recipe_id",lower("variant"),"version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "product_labels_one_draft_key" ON "product_labels" USING btree ("recipe_id",lower("variant")) WHERE "product_labels"."status" = 'draft' and "product_labels"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "product_labels_one_approved_key" ON "product_labels" USING btree ("recipe_id",lower("variant")) WHERE "product_labels"."status" = 'approved' and "product_labels"."deleted_at" is null;--> statement-breakpoint
UPDATE "product_labels" SET "last_edited_by" = "created_by";
