CREATE TABLE "purchase_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"requester_id" uuid,
	"approver_id" uuid,
	"title" text NOT NULL,
	"reason" text NOT NULL,
	"amount" numeric(14, 4) NOT NULL,
	"currency" text NOT NULL,
	"needed_by" date,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" uuid,
	"decision_note" text,
	CONSTRAINT "purchase_requests_amount_check" CHECK ("purchase_requests"."amount" > 0),
	CONSTRAINT "purchase_requests_approver_check" CHECK ("purchase_requests"."approver_id" is distinct from "purchase_requests"."requester_id" or "purchase_requests"."approver_id" is null),
	CONSTRAINT "purchase_requests_status_check" CHECK ("purchase_requests"."status" in ('pending', 'approved', 'rejected', 'withdrawn')),
	CONSTRAINT "purchase_requests_decision_check" CHECK (("purchase_requests"."status" = 'pending') = ("purchase_requests"."decided_at" is null))
);
--> statement-breakpoint
ALTER TABLE "purchase_requests" ADD CONSTRAINT "purchase_requests_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_requests" ADD CONSTRAINT "purchase_requests_requester_id_users_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_requests" ADD CONSTRAINT "purchase_requests_approver_id_users_id_fk" FOREIGN KEY ("approver_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_requests" ADD CONSTRAINT "purchase_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "purchase_requests_workspace_id_idx" ON "purchase_requests" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE INDEX "purchase_requests_requester_idx" ON "purchase_requests" USING btree ("workspace_id","requester_id","id");--> statement-breakpoint
CREATE INDEX "purchase_requests_approver_idx" ON "purchase_requests" USING btree ("workspace_id","approver_id","id");