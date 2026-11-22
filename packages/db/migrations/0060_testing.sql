CREATE TABLE "testing_laboratories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"accreditation" text,
	"accreditation_expires_on" date,
	"in_house" boolean DEFAULT false NOT NULL,
	"contact" text,
	"notes" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "testing_plans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"subject" text NOT NULL,
	"item_id" uuid,
	"sampling_point_id" uuid,
	"frequency_days" integer NOT NULL,
	"rationale" text,
	"laboratory_id" uuid,
	"analytes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_on" date NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "testing_results" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"sample_id" uuid NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"category" text NOT NULL,
	"name" text NOT NULL,
	"unit" text,
	"min" numeric(18, 6),
	"max" numeric(18, 6),
	"limit_text" text,
	"method" text,
	"specification_parameter_id" uuid,
	"value" numeric(18, 6),
	"value_text" text,
	"outcome" text DEFAULT 'pending' NOT NULL,
	"reported_on" date,
	"report_reference" text,
	"recorded_by" uuid,
	"recorded_at" timestamp with time zone,
	"history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "testing_samples" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"subject" text NOT NULL,
	"lot_id" uuid,
	"item_id" uuid,
	"sampling_point_id" uuid,
	"plan_id" uuid,
	"laboratory_id" uuid,
	"specification_version_id" uuid,
	"sampled_on" date NOT NULL,
	"sampled_by" text,
	"notes" text,
	"status" text DEFAULT 'awaiting_results' NOT NULL,
	"outcome" text DEFAULT 'pending' NOT NULL,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancel_reason" text,
	"investigation_status" text,
	"investigation_opened_at" timestamp with time zone,
	"findings" text,
	"root_cause" text,
	"action_taken" text,
	"investigation_closed_at" timestamp with time zone,
	"investigation_closed_by" uuid,
	"lot_held" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "testing_sampling_points" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"zone" text,
	"location" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "testing_laboratories" ADD CONSTRAINT "testing_laboratories_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_plans" ADD CONSTRAINT "testing_plans_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_plans" ADD CONSTRAINT "testing_plans_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_plans" ADD CONSTRAINT "testing_plans_sampling_point_id_testing_sampling_points_id_fk" FOREIGN KEY ("sampling_point_id") REFERENCES "public"."testing_sampling_points"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_plans" ADD CONSTRAINT "testing_plans_laboratory_id_testing_laboratories_id_fk" FOREIGN KEY ("laboratory_id") REFERENCES "public"."testing_laboratories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_plans" ADD CONSTRAINT "testing_plans_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_results" ADD CONSTRAINT "testing_results_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_results" ADD CONSTRAINT "testing_results_sample_id_testing_samples_id_fk" FOREIGN KEY ("sample_id") REFERENCES "public"."testing_samples"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_results" ADD CONSTRAINT "testing_results_specification_parameter_id_specification_parameters_id_fk" FOREIGN KEY ("specification_parameter_id") REFERENCES "public"."specification_parameters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_results" ADD CONSTRAINT "testing_results_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_samples" ADD CONSTRAINT "testing_samples_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_samples" ADD CONSTRAINT "testing_samples_lot_id_stock_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."stock_lots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_samples" ADD CONSTRAINT "testing_samples_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_samples" ADD CONSTRAINT "testing_samples_sampling_point_id_testing_sampling_points_id_fk" FOREIGN KEY ("sampling_point_id") REFERENCES "public"."testing_sampling_points"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_samples" ADD CONSTRAINT "testing_samples_plan_id_testing_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."testing_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_samples" ADD CONSTRAINT "testing_samples_laboratory_id_testing_laboratories_id_fk" FOREIGN KEY ("laboratory_id") REFERENCES "public"."testing_laboratories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_samples" ADD CONSTRAINT "testing_samples_specification_version_id_specification_versions_id_fk" FOREIGN KEY ("specification_version_id") REFERENCES "public"."specification_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_samples" ADD CONSTRAINT "testing_samples_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_samples" ADD CONSTRAINT "testing_samples_investigation_closed_by_users_id_fk" FOREIGN KEY ("investigation_closed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_samples" ADD CONSTRAINT "testing_samples_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_sampling_points" ADD CONSTRAINT "testing_sampling_points_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "testing_laboratories_workspace_idx" ON "testing_laboratories" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE INDEX "testing_plans_workspace_idx" ON "testing_plans" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "testing_results_sample_idx" ON "testing_results" USING btree ("sample_id","sort_order");--> statement-breakpoint
CREATE INDEX "testing_results_name_idx" ON "testing_results" USING btree ("workspace_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "testing_samples_reference_key" ON "testing_samples" USING btree ("workspace_id",lower("reference"));--> statement-breakpoint
CREATE INDEX "testing_samples_sampled_idx" ON "testing_samples" USING btree ("workspace_id","sampled_on");--> statement-breakpoint
CREATE INDEX "testing_samples_lot_idx" ON "testing_samples" USING btree ("lot_id");--> statement-breakpoint
CREATE INDEX "testing_samples_point_idx" ON "testing_samples" USING btree ("sampling_point_id");--> statement-breakpoint
CREATE INDEX "testing_samples_plan_idx" ON "testing_samples" USING btree ("plan_id","sampled_on");--> statement-breakpoint
CREATE UNIQUE INDEX "testing_sampling_points_code_key" ON "testing_sampling_points" USING btree ("workspace_id",lower("code")) WHERE "testing_sampling_points"."deleted_at" is null;