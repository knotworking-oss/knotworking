CREATE TABLE "item_suppliers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"supplier_code" text,
	"preferred" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"description" text,
	"unit" text NOT NULL,
	"density_g_per_ml" numeric(12, 6),
	"unit_weight_g" numeric(14, 4),
	"allergens" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"may_contain" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"storage" text DEFAULT 'ambient' NOT NULL,
	"shelf_life_days" integer,
	"standard_cost" numeric(14, 4),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"code" text,
	"contact_name" text,
	"email" text,
	"phone" text,
	"address" text,
	"notes" text,
	"certification" text,
	"certificate_expires_on" date,
	"approval_status" text DEFAULT 'pending' NOT NULL,
	"approval_changed_at" timestamp with time zone,
	"approval_changed_by" uuid,
	"approval_note" text,
	"review_due_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "item_suppliers" ADD CONSTRAINT "item_suppliers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_suppliers" ADD CONSTRAINT "item_suppliers_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_suppliers" ADD CONSTRAINT "item_suppliers_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_approval_changed_by_users_id_fk" FOREIGN KEY ("approval_changed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "item_suppliers_key" ON "item_suppliers" USING btree ("item_id","supplier_id");--> statement-breakpoint
CREATE INDEX "item_suppliers_supplier_idx" ON "item_suppliers" USING btree ("supplier_id");--> statement-breakpoint
CREATE UNIQUE INDEX "items_workspace_code_key" ON "items" USING btree ("workspace_id",lower("code")) WHERE "items"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "items_workspace_type_idx" ON "items" USING btree ("workspace_id","type");--> statement-breakpoint
CREATE INDEX "suppliers_workspace_idx" ON "suppliers" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "suppliers_workspace_code_key" ON "suppliers" USING btree ("workspace_id",lower("code")) WHERE "suppliers"."deleted_at" is null and "suppliers"."code" is not null;