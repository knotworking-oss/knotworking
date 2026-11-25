import { z } from "zod";

/**
 * Sync protocol
 * -------------
 * Every write the server accepts also appends a row to `sync_changes` in the
 * same transaction. Each row carries a per-workspace, monotonically increasing
 * cursor. Clients:
 *
 *   1. Bootstrap: `GET /v1/workspaces/:slug/bootstrap` → full snapshot + `cursor`.
 *   2. Catch up:  `GET /v1/workspaces/:slug/sync?after=<cursor>` → ordered changes
 *      (upserts carry the full entity; deletes are tombstones).
 *   3. Apply changes to a local store (`SyncStore` in ./sync-store: memory on web
 *      today; SQLite on desktop and mobile later) and persist the new cursor.
 *   4. Stay current: `GET /v1/workspaces/:slug/events` is a server-sent event
 *      stream that nudges the client to pull again (see `SyncNudge`). It never
 *      carries entity data, so access control stays in `/sync`.
 *
 * This is the backbone that lets a desktop or mobile client work offline and
 * stay consistent without bespoke endpoints per screen.
 */

export const syncEntityTypes = [
  "workspace",
  /** Enabled modules changed. Clients fetch a new snapshot under the new scope. */
  "workspace_modules",
  "service_quote",
  // CRM: ids and revisions only; leads, opportunities and follow-ups are read through queries.
  "crm_stage",
  "crm_lead",
  "crm_opportunity",
  "crm_activity",
  "workspace_member",
  /** A member's level in one module (`member_module_access`). Clients refetch when their own changes. */
  "module_access",
  /**
   * An API access toggle switched on or off for the workspace (`workspace_token_actions`): always an
   * upsert carrying `{ id, action, module, enabled, enabledBy, enabledAt }`, with `enabledBy` the
   * person's name as `GET …/token-actions` gives it. Clients (and the MCP tool list) may refetch that.
   */
  "token_action",
  "user",
  "team",
  "team_member",
  "workflow_state",
  "label",
  "project",
  "project_team",
  "task",
  "task_label",
  "task_relation",
  "document",
  "comment",
  "time_entry",
  "attachment",
  "meeting",
  "meeting_attendee",
  // Items module.
  "supplier",
  "item",
  "item_supplier",
  "supplier_risk_assessment",
  "supplier_questionnaire",
  "supplier_control_settings",
  // Recipes module.
  "recipe",
  "recipe_version",
  "recipe_line",
  // SOPs module (metadata only: never draft or version content).
  "sop",
  "sop_version",
  "sop_acknowledgement",
  "sop_target",
  "sop_copy",
  // Stock module.
  "stock_location",
  "stock_lot",
  "stock_movement",
  // Customer and despatch metadata (never contact/address snapshots).
  "customer",
  "despatch",
  "hse_record",
  "hse_entry",
  "hse_permit",
  "sales_order",
  "sales_price",
  "sales_external_reference",
  /** A lot release rule per item (stock module). Releases themselves are read through endpoints. */
  "lot_release_rule",
  // Demand module.
  "demand_line",
  "demand_import",
  "demand_pack_unit",
  // Production module.
  "production_batch",
  "production_record",
  "production_line",
  "production_line_recipe",
  "production_reservation",
  "production_non_working_day",
  "production_line_shift",
  "production_changeover",
  "production_downtime",
  "production_reject",
  "production_labour",
  "production_packing_run",
  "production_packing_check",
  "production_device",
  "production_device_reading",
  // Assets module: the shared register (metadata only).
  "asset",
  // Food safety records (HACCP) module.
  "haccp_plan",
  "haccp_plan_version",
  "haccp_process_step",
  "haccp_ccp",
  "haccp_ccp_log",
  "haccp_corrective_action",
  "haccp_asset",
  "haccp_cleaning_record",
  "haccp_calibration_record",
  "haccp_day_signoff",
  "haccp_hazard_library",
  "haccp_plan_template",
  // People module (never PINs or lock-out counters).
  "staff",
  "job_role",
  "staff_job_role",
  // Training module.
  "training_course",
  "training_requirement",
  "training_record",
  // Quality module (never a complainant's name or contact details).
  "quality_complaint",
  "quality_nonconformance",
  "quality_audit",
  "quality_recall_test",
  "quality_audit_programme",
  "quality_sales_volume",
  "quality_incident",
  "quality_authenticity",
  // Purchasing module.
  "purchase_order",
  "purchase_order_line",
  "purchase_receipt",
  "purchase_invoice",
  "purchase_invoice_line",
  "purchasing_settings",
  "purchase_order_email",
  "purchase_supplier_price",
  "purchase_credit_note",
  "purchase_credit_note_line",
  // Costing module.
  "costing_period_close",
  "costing_standard_cost",
  "costing_absorption_rate",
  // General checklists.
  "checklist_template",
  "checklist_item",
  "checklist_check",
  "checklist_check_item",
  "checklist_action",
  // Site programmes module.
  "site_pest_device",
  "site_pest_visit",
  "site_pest_finding",
  "site_glass_item",
  "site_glass_check",
  "site_glass_breakage",
  "site_asset",
  "site_maintenance_task",
  "site_maintenance_record",
  "site_work_order",
  "site_storage_unit",
  "site_storage_reading",
  "site_corrective_action",
  "site_checklist_template",
  "site_checklist_item",
  "site_checklist_check",
  "site_checklist_check_item",
  // Labels and nutrition module.
  "item_label_data",
  "product_label",
  // Specifications module (metadata only: never a version's content).
  "specification",
  "specification_version",
  // Testing module (metadata only: never results or investigation findings).
  "testing_laboratory",
  "testing_sampling_point",
  "testing_plan",
  "testing_sample",
  // Product development module.
  "npd_project",
  "npd_trial",
  // Food defence module.
  "defence_assessment",
  "defence_assessment_version",
  "defence_control",
  "defence_check",
  "defence_exercise",
  // Governance module (confidential concerns are never synced).
  "governance_objective",
  "governance_culture_activity",
  "governance_requirement",
  "governance_review",
  "governance_standard",
  "governance_standard_clause",
  "governance_clause_assessment",
  "governance_clause_task",
  "governance_clause_evidence",
  "governance_clause_draft",
  "governance_gap_snapshot",
  // Dashboards module: definitions and their history, filtered by audience (never query results),
  // and board snapshot and pack headers (never their figures).
  "bi_dashboard",
  "bi_dashboard_version",
  "bi_snapshot",
  "bi_board_pack",
] as const;
export type SyncEntityType = (typeof syncEntityTypes)[number];

export type SyncAction = "upsert" | "delete";

export interface SyncChange<T = Record<string, unknown>> {
  /** Cursor — compare numerically; serialized as string to survive JSON bigint limits. */
  id: string;
  entity: SyncEntityType;
  entityId: string;
  action: SyncAction;
  data: T | null;
  actorId: string | null;
  createdAt: string;
}

export interface SyncPage {
  changes: SyncChange[];
  cursor: string;
  hasMore: boolean;
}

export const syncQuerySchema = z.object({
  after: z.string().regex(/^\d+$/).default("0"),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});

/** SSE event name on `/events`: the workspace's sync log advanced. */
export const SYNC_NUDGE_EVENT = "sync";

/** Payload of a nudge: the latest cursor. Clients pull if it is ahead of theirs. */
export interface SyncNudge {
  cursor: string;
}

/**
 * Header carrying the browser's IP from the web app's /api proxy to the API
 * (used for rate limiting). The proxy always overwrites it, so it can't be spoofed.
 */
export const CLIENT_IP_HEADER = "x-knotworking-client-ip";
