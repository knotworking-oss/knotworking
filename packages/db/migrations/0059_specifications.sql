CREATE TABLE "specification_parameters" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"category" text NOT NULL,
	"name" text NOT NULL,
	"unit" text,
	"min" numeric(18, 6),
	"target" numeric(18, 6),
	"max" numeric(18, 6),
	"limit_text" text,
	"method" text,
	"note" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "specification_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"specification_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"description" text,
	"storage" text,
	"storage_instructions" text,
	"shelf_life_days" integer,
	"minimum_life_on_receipt_days" integer,
	"allergens" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"may_contain" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"country_of_origin" text,
	"provenance" text,
	"claims" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"packaging_details" text,
	"review_due_on" date,
	"agreed_by" text,
	"agreed_on" date,
	"agreement_reference" text,
	"change_note" text,
	"last_edited_by" uuid,
	"approved_at" timestamp with time zone,
	"approved_by" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "specifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"item_id" uuid NOT NULL,
	"supplier_id" uuid,
	"customer_name" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "specification_parameters" ADD CONSTRAINT "specification_parameters_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specification_parameters" ADD CONSTRAINT "specification_parameters_version_id_specification_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."specification_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specification_versions" ADD CONSTRAINT "specification_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specification_versions" ADD CONSTRAINT "specification_versions_specification_id_specifications_id_fk" FOREIGN KEY ("specification_id") REFERENCES "public"."specifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specification_versions" ADD CONSTRAINT "specification_versions_last_edited_by_users_id_fk" FOREIGN KEY ("last_edited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specification_versions" ADD CONSTRAINT "specification_versions_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specification_versions" ADD CONSTRAINT "specification_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specifications" ADD CONSTRAINT "specifications_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specifications" ADD CONSTRAINT "specifications_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specifications" ADD CONSTRAINT "specifications_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specifications" ADD CONSTRAINT "specifications_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "specification_parameters_version_idx" ON "specification_parameters" USING btree ("version_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "specification_versions_number_key" ON "specification_versions" USING btree ("specification_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "specification_versions_one_draft_key" ON "specification_versions" USING btree ("specification_id") WHERE "specification_versions"."status" = 'draft' and "specification_versions"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "specification_versions_one_approved_key" ON "specification_versions" USING btree ("specification_id") WHERE "specification_versions"."status" = 'approved' and "specification_versions"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "specification_versions_review_idx" ON "specification_versions" USING btree ("workspace_id","status","review_due_on");--> statement-breakpoint
CREATE UNIQUE INDEX "specifications_workspace_code_key" ON "specifications" USING btree ("workspace_id",lower("code")) WHERE "specifications"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "specifications_item_idx" ON "specifications" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "specifications_supplier_idx" ON "specifications" USING btree ("supplier_id");