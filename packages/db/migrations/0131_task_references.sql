CREATE TABLE "task_reference_counters" (
	"workspace_id" uuid NOT NULL,
	"prefix" text NOT NULL,
	"last_number" integer NOT NULL,
	CONSTRAINT "task_reference_counters_workspace_id_prefix_pk" PRIMARY KEY("workspace_id","prefix")
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "reference" text;--> statement-breakpoint
ALTER TABLE "task_reference_counters" ADD CONSTRAINT "task_reference_counters_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_workspace_reference_key" ON "tasks" USING btree ("workspace_id","reference");
