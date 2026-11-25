CREATE TABLE "accounting_xero_credentials" (
	"workspace_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"organisation_name" text NOT NULL,
	"base_currency" text NOT NULL,
	"remote_connection_id" uuid,
	"ciphertext" text,
	"verified_at" timestamp with time zone NOT NULL,
	CONSTRAINT "accounting_xero_credentials_workspace_id_connection_id_pk" PRIMARY KEY("workspace_id","connection_id")
);
--> statement-breakpoint
CREATE TABLE "accounting_xero_flows" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"state_hash" text,
	"ciphertext" text,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounting_xero_credentials" ADD CONSTRAINT "accounting_xero_credentials_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_xero_credentials" ADD CONSTRAINT "accounting_xero_credentials_workspace_id_connection_id_accounting_connections_workspace_id_id_fk" FOREIGN KEY ("workspace_id","connection_id") REFERENCES "public"."accounting_connections"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_xero_flows" ADD CONSTRAINT "accounting_xero_flows_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_xero_flows" ADD CONSTRAINT "accounting_xero_flows_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_xero_flows" ADD CONSTRAINT "accounting_xero_flows_workspace_id_connection_id_accounting_connections_workspace_id_id_fk" FOREIGN KEY ("workspace_id","connection_id") REFERENCES "public"."accounting_connections"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounting_xero_remote_connection_key" ON "accounting_xero_credentials" USING btree ("remote_connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "accounting_xero_flow_connection_key" ON "accounting_xero_flows" USING btree ("workspace_id","connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "accounting_xero_flow_state_key" ON "accounting_xero_flows" USING btree ("state_hash");--> statement-breakpoint
CREATE INDEX "accounting_xero_flow_expiry_idx" ON "accounting_xero_flows" USING btree ("expires_at");