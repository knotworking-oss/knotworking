import type { ModuleId } from "./modules";

/**
 * API access toggles ("token actions")
 * ------------------------------------
 * Some module routes refuse personal API tokens (and so the MCP server and integrations): a
 * person must do them. A few of those are ordinary operations a workspace may reasonably hand to
 * an integration or agent (send a purchase order, record waste from a scale, post a stocktake from
 * a counting app). Owners and admins may switch those on per workspace (Settings → API access):
 * each is a {@link TokenActionDefinition} here.
 *
 * Everything else that refuses tokens stays a person's act and can't be switched on: sign-offs and
 * approvals (BRCGS: sign-off is a person), records that attest a person did something, corrections
 * of the ledger, and safety and security. {@link personOnlyActions} lists them with the reason,
 * so the settings page can show "Always a person".
 *
 * A token let through by a toggle still needs its owner's module level (the route's own
 * requirement, `level` below) and its own module allowlist. Every such call is audited.
 */

export const tokenActionIds = [
  "purchasing.send",
  "purchasing.close",
  "purchasing.cancel",
  "stock.waste",
  "stock.adjust",
  "stock.stocktake",
  "production.cancel",
  "attendance.events",
  "attendance.visit_sign_out",
  "attendance.payroll_export",
  "bi.publish",
  "bi.board_packs",
  "tasks.custom_fields",
] as const;
export type TokenActionId = (typeof tokenActionIds)[number];

export interface TokenActionDefinition {
  id: TokenActionId;
  module: ModuleId;
  /** Short name for the switch, e.g. "Send purchase orders". */
  label: string;
  /** One sentence: what an agent or integration could then do. */
  description: string;
  /** Access level the token's owner still needs in `module` (the route's own requirement). */
  level: "write" | "manage";
}

export const tokenActions: { readonly [K in TokenActionId]: TokenActionDefinition & { id: K } } = {
  "purchasing.send": {
    id: "purchasing.send",
    module: "purchasing",
    label: "Send purchase orders",
    description:
      "Tokens may mark a draft purchase order as sent to its supplier, committing to the order, and email a sent order to the supplier.",
    level: "manage",
  },
  "purchasing.close": {
    id: "purchasing.close",
    module: "purchasing",
    label: "Close purchase orders",
    description: "Tokens may close a sent purchase order that will receive nothing more.",
    level: "write",
  },
  "purchasing.cancel": {
    id: "purchasing.cancel",
    module: "purchasing",
    label: "Cancel purchase orders",
    description: "Tokens may cancel a purchase order with a reason.",
    level: "write",
  },
  "stock.waste": {
    id: "stock.waste",
    module: "stock",
    label: "Record waste",
    description: "Tokens may write off stock as waste, for example from a waste scale.",
    level: "write",
  },
  "stock.adjust": {
    id: "stock.adjust",
    module: "stock",
    label: "Post stock adjustments",
    description: "Tokens may post adjustments that add or remove stock outside receipts and usage.",
    level: "manage",
  },
  "stock.stocktake": {
    id: "stock.stocktake",
    module: "stock",
    label: "Post stocktakes",
    description:
      "Tokens may post counted stock, for example from a stock-counting app, adjusting the ledger to it.",
    level: "manage",
  },
  "production.cancel": {
    id: "production.cancel",
    module: "production",
    label: "Cancel production batches",
    description:
      "Tokens may cancel a planned batch (or, when the token's owner has manage, one that has started with no output).",
    level: "write",
  },
  "attendance.events": {
    id: "attendance.events",
    module: "attendance",
    label: "Add clock events",
    description: "Tokens may add clock-in and clock-out events, for example from another clocking system.",
    level: "write",
  },
  "attendance.visit_sign_out": {
    id: "attendance.visit_sign_out",
    module: "attendance",
    label: "Sign visitors out",
    description: "Tokens may sign a visitor out of the on-site register.",
    level: "write",
  },
  "attendance.payroll_export": {
    id: "attendance.payroll_export",
    module: "attendance",
    label: "Export payroll",
    description:
      "Tokens may download the payroll export, which holds staff names, staff numbers and hours worked (personal data).",
    level: "manage",
  },
  "bi.publish": {
    id: "bi.publish",
    module: "bi",
    label: "Publish dashboards",
    description:
      "Tokens may publish a dashboard to an audience or take it back to draft. Viewers still only see data their own access allows.",
    level: "manage",
  },
  "bi.board_packs": {
    id: "bi.board_packs",
    module: "bi",
    label: "Build board packs",
    description:
      "Tokens may freeze dashboard snapshots and build, issue or delete board packs. Snapshots hold the figures as the token's owner could read them, and issuing a pack shares them with its audience.",
    level: "manage",
  },
  "tasks.custom_fields": {
    id: "tasks.custom_fields",
    module: "tasks",
    label: "Manage custom fields",
    description: "Tokens may create, edit, or remove task and project custom field definitions.",
    level: "manage",
  },
};

/** The toggleable actions in display order. */
export const tokenActionList: readonly TokenActionDefinition[] = tokenActionIds.map((id) => tokenActions[id]);

export const isTokenActionId = (value: string): value is TokenActionId =>
  (tokenActionIds as readonly string[]).includes(value);

/** Why a person-only action can never be opened to tokens. */
export type PersonOnlyKind = "sign_off" | "attestation" | "correction" | "safety";

export const personOnlyReasons: Record<PersonOnlyKind, string> = {
  sign_off: "A sign-off or approval: under BRCGS, sign-off is a person.",
  attestation: "A record that a person did something, so a person must make it.",
  correction: "A correction of the ledger: a person answers for it.",
  safety: "Safety and security: kept to people signed in with their own account.",
};

export interface PersonOnlyAction {
  module: ModuleId;
  label: string;
  kind: PersonOnlyKind;
  reason: string;
}

const personOnly = (module: ModuleId, label: string, kind: PersonOnlyKind): PersonOnlyAction => ({
  module,
  label,
  kind,
  reason: personOnlyReasons[kind],
});

/**
 * Routes that refuse API tokens and can't be switched on. Fixed: the server's route
 * classification test checks that every `forbidTokens` route is one of these or a toggleable
 * {@link tokenActions} entry.
 */
export const personOnlyActions: readonly PersonOnlyAction[] = [
  personOnly("automation", "Manage and preview task automation rules", "safety"),
  personOnly("automation", "Manage and run automation pipelines", "safety"),
  personOnly("workforce", "Manage personal leave and sickness requests", "attestation"),
  personOnly("workforce_hr", "Access private HR absence records", "attestation"),
  personOnly("workforce_hr", "Prepare, approve and export payroll runs", "sign_off"),
  // Sign-offs and approvals.
  personOnly("purchase_requests", "Decide or withdraw purchase requests", "sign_off"),
  personOnly("invoicing", "Approve or discard customer invoices and credit notes", "sign_off"),
  personOnly("client_services", "Sign client service quote and delivery decisions", "sign_off"),
  personOnly("crm", "Hand off won opportunities to an order or delivery project", "sign_off"),
  personOnly("items", "Approve or suspend suppliers", "sign_off"),
  personOnly("items", "Assess supplier risk", "sign_off"),
  personOnly("items", "Accept or reject supplier questionnaires", "sign_off"),
  personOnly("recipes", "Approve recipe versions", "sign_off"),
  personOnly("sops", "Approve or reject SOP versions", "sign_off"),
  personOnly("haccp", "Approve HACCP plans", "sign_off"),
  personOnly("haccp", "Change a HACCP plan's status", "sign_off"),
  personOnly("items", "Change supplier control enforcement", "sign_off"),
  personOnly("stock", "Release, quarantine or reject lots", "sign_off"),
  personOnly("stock", "Change lot release rules", "sign_off"),
  personOnly("production", "Complete batches", "sign_off"),
  personOnly("training", "Sign off training", "sign_off"),
  personOnly("haccp", "Review CCP logs", "sign_off"),
  personOnly("haccp", "Close corrective actions", "sign_off"),
  personOnly("haccp", "Verify cleaning", "sign_off"),
  personOnly("quality", "Close or reopen complaints", "sign_off"),
  personOnly("quality", "Close or reopen non-conformances", "sign_off"),
  personOnly("quality", "Complete audits", "sign_off"),
  personOnly("quality", "Record supplier reviews of non-conformances", "sign_off"),
  personOnly("quality", "Record recall tests", "sign_off"),
  personOnly("site", "Review storage temperature readings", "sign_off"),
  personOnly("site", "Close site corrective actions", "sign_off"),
  personOnly("site", "Release an area after a glass breakage", "sign_off"),
  personOnly("maintenance", "Give return-to-service clearance", "sign_off"),
  personOnly("site", "Sign off pre-start and changeover checks", "sign_off"),
  personOnly("haccp", "Sign off a day's CCP monitoring", "sign_off"),
  personOnly("haccp", "Sign off several plans' CCP monitoring at once", "sign_off"),
  personOnly("haccp", "Review a plan's hazard analysis", "sign_off"),
  personOnly("labels", "Approve product labels", "sign_off"),
  personOnly("specifications", "Approve specifications", "sign_off"),
  personOnly("testing", "Close test investigations", "sign_off"),
  personOnly("npd", "Launch new products", "sign_off"),
  personOnly("npd", "Record product development sign-offs", "attestation"),
  personOnly("defence", "Approve food defence assessments", "sign_off"),
  personOnly("defence", "Record security checks", "attestation"),
  personOnly("defence", "Resolve failed security checks", "attestation"),
  personOnly("defence", "Record food defence exercises", "attestation"),
  personOnly("governance", "Sign management reviews", "sign_off"),
  personOnly("governance", "Record compliance reviews", "attestation"),
  personOnly("governance", "Read and handle confidential concerns", "safety"),
  personOnly("purchasing", "Approve supplier invoices for payment", "sign_off"),
  personOnly("purchasing", "Approve supplier credit notes", "sign_off"),
  personOnly("purchasing", "Approve purchase orders for sending", "sign_off"),
  personOnly("costing", "Close or reopen costing periods", "sign_off"),
  personOnly("quality", "Contain incident stock", "sign_off"),
  personOnly("quality", "Record incident evidence", "sign_off"),
  personOnly("quality", "Release incident holds", "sign_off"),
  personOnly("quality", "Close incident cases", "sign_off"),
  personOnly("quality", "Approve authenticity assessments", "sign_off"),
  personOnly("quality", "Verify authenticity controls", "attestation"),
  personOnly("quality", "Correct authenticity verification records", "correction"),
  personOnly("quality", "Archive authenticity assessments", "sign_off"),

  personOnly("hse", "Approve HSE registers", "attestation"),
  personOnly("hse", "Archive HSE registers", "attestation"),
  personOnly("hse", "Record HSE verifications", "attestation"),
  personOnly("hse", "Correct HSE verification records", "attestation"),
  personOnly("hse", "Issue HSE permits", "attestation"),
  personOnly("hse", "Suspend HSE permits", "attestation"),
  personOnly("hse", "Resume HSE permits", "attestation"),
  personOnly("hse", "Close HSE permits", "attestation"),
  personOnly("hse", "Cancel HSE permits", "attestation"),
  personOnly("hse_incidents", "Access restricted HSE incidents", "attestation"),
  personOnly("sales", "Amend confirmed sales orders", "sign_off"),
  personOnly("sales", "Confirm sales orders", "sign_off"),
  personOnly("sales", "Issue sales quotes", "sign_off"),
  personOnly("sales", "Cancel sales documents", "sign_off"),
  personOnly("sales", "Convert sales quotes", "sign_off"),
  personOnly("sales", "Link sales deliveries", "sign_off"),
  personOnly("sales", "Correct sales delivery links", "sign_off"),
  personOnly("sales", "Agree sales prices", "sign_off"),
  personOnly("sales", "Archive sales prices", "sign_off"),
  personOnly("despatch", "Allocate despatch stock", "attestation"),
  personOnly("despatch", "Release despatch allocations", "correction"),
  personOnly("despatch", "Sign despatch packing", "attestation"),
  personOnly("despatch", "Sign despatch load checks", "attestation"),
  personOnly("despatch", "Record delivery proof", "attestation"),
  personOnly("despatch", "Receive customer returns", "attestation"),
  personOnly("despatch", "Void customer return receipts", "correction"),
  personOnly("despatch", "Confirm despatches", "attestation"),
  personOnly("despatch", "Void despatches", "correction"),
  // Records that attest a person did something.
  personOnly("sops", "Acknowledge SOPs", "attestation"),
  personOnly("sops", "Issue and call in controlled SOP copies", "attestation"),
  personOnly("haccp", "Record cleaning", "attestation"),
  personOnly("haccp", "Record calibration", "attestation"),
  personOnly("haccp", "Correct CCP log entries", "attestation"),
  personOnly("haccp", "Correct cleaning records", "attestation"),
  personOnly("haccp", "Correct calibration records", "attestation"),
  personOnly("site", "Record glass and brittle plastics checks", "attestation"),
  personOnly("maintenance", "Record completed maintenance", "attestation"),
  personOnly("maintenance", "Complete work orders", "attestation"),
  personOnly("maintenance", "Cancel work orders", "attestation"),
  personOnly("site", "Record pre-start and changeover checks", "attestation"),
  personOnly("site", "Correct site records", "attestation"),
  personOnly("checklists", "Record completed checklists", "attestation"),
  personOnly("checklists", "Correct checklist results", "attestation"),
  personOnly("checklists", "Resolve checklist follow-ups", "attestation"),
  personOnly("maintenance", "Correct maintenance records", "attestation"),
  // Corrections of the ledger.
  personOnly("stock", "Reverse stock movements", "correction"),
  personOnly("production", "Reverse production records", "correction"),
  personOnly("production", "Void downtime, reject and labour records", "correction"),
  personOnly("production", "Close packing runs", "sign_off"),
  personOnly("production", "Void packing checks", "correction"),
  personOnly("routings", "Approve routing versions", "sign_off"),
  personOnly("routings", "Void job card time and quantity records", "correction"),
  personOnly("routings", "Resolve job card exceptions", "attestation"),
  personOnly("governance", "Assess compliance against a standard", "attestation"),
  personOnly("attendance", "Void clock events", "correction"),
  personOnly("training", "Void training records", "correction"),
  personOnly("quality", "Void recall tests", "correction"),
  personOnly("purchasing", "Void refused deliveries and non-stock receipts", "correction"),
  personOnly("purchasing", "Void supplier credit notes", "correction"),
  // Safety and security.
  personOnly("attendance", "Run roll calls", "safety"),
  personOnly("attendance", "Manage kiosk devices and pairing codes", "safety"),
  personOnly("attendance", "Issue or revoke kiosk badges", "safety"),
  personOnly("attendance", "Dismiss refused kiosk events", "safety"),
  personOnly("people", "Set or clear staff PINs and unlock them", "safety"),
  personOnly("attendance", "Change attendance settings", "safety"),
  personOnly("purchasing", "Change invoice match tolerances", "safety"),
  personOnly("purchasing", "Change purchase order approval and over-delivery settings", "safety"),
  personOnly(
    "invoicing",
    "Change invoicing settings: the seller tax registration number and second-approver rule",
    "safety",
  ),
  personOnly("costing", "Change standard costs and absorption rates", "safety"),
];

/** The largest value a per-token order limit may be set to (a sanity bound for the numeric column). */
export const MAX_TOKEN_ORDER_VALUE = 1_000_000_000;

/**
 * Whether a token may use `action`, given the workspace's toggle and the token's own allowlist.
 * `allowlist` null is a token made before allowlists existed: every action the workspace has
 * switched on. The workspace must always have switched the action on as well.
 */
export const tokenMayUseAction = (
  allowlist: readonly string[] | null | undefined,
  action: TokenActionId,
): boolean => allowlist == null || allowlist.includes(action);

/** The message a token gets when the workspace allows `action` but the token's own allowlist doesn't. */
export const tokenAllowlistRefusal = (action: TokenActionId) =>
  `This API token isn't allowed to ${tokenActions[action].label.toLowerCase()}. Its owner can allow "${tokenActions[action].label}" for it under Settings → API tokens`;

/** The message for a purchase order a token may not send because of its value. */
export const orderValueLimitRefusal = (limit: number, value: number | null) =>
  value === null
    ? `This API token may only send purchase orders worth up to ${formatTokenLimit(limit)}, and this order has a line with no price, so its value can't be checked. A person can send it`
    : `This purchase order is worth ${formatTokenLimit(value)}, over this API token's limit of ${formatTokenLimit(limit)} per order. A person can send it, or the token's owner can raise the limit under Settings → API tokens`;

/** Money as the limit messages show it: two places, no currency (the workspace has none). */
export const formatTokenLimit = (value: number) => value.toFixed(2);

/** One action as `GET …/token-actions` reports it. */
export interface TokenActionState extends TokenActionDefinition {
  enabled: boolean;
  /**
   * For a token calling the list: whether the token's own allowlist lets it use the action (the
   * action also needs `enabled`). `null` for a signed-in person, to whom it doesn't apply.
   */
  allowedForToken: boolean | null;
  /** Name of the person who switched it on (`null` when off, or when they have since been deleted). */
  enabledBy: string | null;
  enabledAt: string | null;
}

/** The message a token gets when the workspace hasn't switched `action` on. */
export const tokenActionRefusal = (action: TokenActionId) =>
  `API tokens can't ${tokenActions[action].label.toLowerCase()} in this workspace unless an owner or admin allows "${tokenActions[action].label}" under Settings → API access`;
