import { personOnlyActions, tokenActionIds, tokenActions, type TokenActionId } from "@knotworking/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { forbidTokens } from "./middleware/auth";
import { tokenActionOfHandler } from "./middleware/token-actions";
import { moduleOfRoute, workspaceSubPath } from "./modules/routes";
import { makeApp, signIn, type TestCtx } from "./test-utils";

type Classification =
  /** Safe for personal API tokens (`knw_…`); a read-scope token is limited to GET by `requireSession`. */
  | "token-ok"
  /** Personal or admin: a token must be refused with 403 `token_not_allowed` or `session_required`. */
  | "token-forbidden"
  /**
   * A person's act an owner or admin may open to tokens (`personOrToken`, see TOKEN_ACTION_ROUTES):
   * refused with 403 `token_not_allowed` until the workspace switches the action on.
   */
  | "token-action"
  /** Reachable without any credential. */
  | "public"
  /** The attendance kiosk: a paired tablet's credential (`knk_…`) only; sessions and personal tokens are refused. */
  | "device";

/**
 * Every route under `/v1` and `/api` that the app registers, classified for personal API tokens.
 *
 * Token access is a deny-list (`forbidTokens`, `requireAdmin`, `requireSessionCredential`, plus
 * the path guards in app.ts), so a new route is reachable by agent tokens unless someone remembers
 * to guard it. This table is the safety net: a new route fails this test until it is classified
 * here. New personal or admin routes (calendar, connections, token management, member and
 * workspace administration, anything acting through the user's external accounts) must be
 * classified `token-forbidden` AND guarded with `forbidTokens` (or `requireAdmin` /
 * `requireSessionCredential`), and the test below then proves the guard works.
 *
 * Keys are "METHOD path" exactly as Hono registers them.
 */
const ROUTES: Record<string, Classification> = {
  "GET /v1/workspaces/:slug/checklists/due": "token-ok",
  "GET /v1/workspaces/:slug/checklists/templates": "token-ok",
  "GET /v1/workspaces/:slug/checklists/templates/:id": "token-ok",
  "POST /v1/workspaces/:slug/checklists/templates": "token-ok",
  "PATCH /v1/workspaces/:slug/checklists/templates/:id": "token-ok",
  "GET /v1/workspaces/:slug/checklists/checks": "token-ok",
  "GET /v1/workspaces/:slug/checklists/checks/:id": "token-ok",
  "POST /v1/workspaces/:slug/checklists/checks": "token-forbidden",
  "POST /v1/workspaces/:slug/checklists/checks/:id/correct": "token-forbidden",
  "GET /v1/workspaces/:slug/checklists/actions": "token-ok",
  "POST /v1/workspaces/:slug/checklists/actions/:id/resolve": "token-forbidden",
  "GET /v1/workspaces/:slug/bi/datasets": "token-ok",
  "GET /v1/workspaces/:slug/bi/query": "token-ok",
  "GET /v1/workspaces/:slug/bi/dashboards": "token-ok",
  "POST /v1/workspaces/:slug/bi/dashboards": "token-ok",
  "GET /v1/workspaces/:slug/bi/dashboards/:id": "token-ok",
  "PATCH /v1/workspaces/:slug/bi/dashboards/:id": "token-ok",
  "GET /v1/workspaces/:slug/bi/dashboards/:id/versions": "token-ok",
  "GET /v1/workspaces/:slug/bi/dashboards/:id/data": "token-ok",
  "POST /v1/workspaces/:slug/bi/dashboards/:id/duplicate": "token-ok",
  "POST /v1/workspaces/:slug/bi/dashboards/:id/archive": "token-ok",
  "POST /v1/workspaces/:slug/bi/dashboards/:id/restore": "token-ok",
  "POST /v1/workspaces/:slug/bi/dashboards/:id/publish": "token-action",
  "POST /v1/workspaces/:slug/bi/dashboards/:id/unpublish": "token-action",
  "POST /v1/workspaces/:slug/bi/dashboards/:id/snapshots": "token-action",
  "GET /v1/workspaces/:slug/bi/snapshots": "token-ok",
  "GET /v1/workspaces/:slug/bi/snapshots/:id": "token-ok",
  "GET /v1/workspaces/:slug/bi/sources": "token-ok",
  "POST /v1/workspaces/:slug/bi/analyses": "token-ok",
  "GET /v1/workspaces/:slug/bi/packs": "token-ok",
  "GET /v1/workspaces/:slug/bi/packs/:id": "token-ok",
  "POST /v1/workspaces/:slug/bi/packs": "token-action",
  "PATCH /v1/workspaces/:slug/bi/packs/:id": "token-action",
  "POST /v1/workspaces/:slug/bi/packs/:id/issue": "token-action",
  "DELETE /v1/workspaces/:slug/bi/packs/:id": "token-action",
  "GET /v1/workspaces/:slug/workforce/availability": "token-ok",
  "GET /v1/workspaces/:slug/workforce/me": "token-forbidden",
  "POST /v1/workspaces/:slug/workforce/me/absences": "token-forbidden",
  "POST /v1/workspaces/:slug/workforce/me/absences/:id/withdraw": "token-forbidden",
  "GET /v1/workspaces/:slug/workforce/hr/absences": "token-forbidden",
  "POST /v1/workspaces/:slug/workforce/hr/absences": "token-forbidden",
  "GET /v1/workspaces/:slug/workforce/hr/absences/:id/history": "token-forbidden",
  "POST /v1/workspaces/:slug/workforce/hr/absences/:id/decision": "token-forbidden",
  "POST /v1/workspaces/:slug/workforce/hr/absences/:id/correct": "token-forbidden",
  "GET /v1/workspaces/:slug/workforce/hr/staff": "token-forbidden",
  "GET /v1/workspaces/:slug/workforce/hr/payroll-runs": "token-forbidden",
  "GET /v1/workspaces/:slug/workforce/hr/payroll-runs/preview": "token-forbidden",
  "POST /v1/workspaces/:slug/workforce/hr/payroll-runs": "token-forbidden",
  "GET /v1/workspaces/:slug/workforce/hr/payroll-runs/:id": "token-forbidden",
  "POST /v1/workspaces/:slug/workforce/hr/payroll-runs/:id/approve": "token-forbidden",
  "POST /v1/workspaces/:slug/workforce/hr/payroll-runs/:id/correct": "token-forbidden",
  "POST /v1/workspaces/:slug/workforce/hr/payroll-runs/:id/export": "token-forbidden",
  "POST /v1/workspaces/:slug/workforce/hr/payroll-runs/:id/withdraw": "token-forbidden",
  "GET /v1/workspaces/:slug/workforce/shifts": "token-ok",
  "POST /v1/workspaces/:slug/workforce/shifts": "token-ok",
  "PATCH /v1/workspaces/:slug/workforce/shifts/:id": "token-ok",
  "GET /v1/workspaces/:slug/workforce/patterns": "token-ok",
  "POST /v1/workspaces/:slug/workforce/patterns": "token-ok",
  "POST /v1/workspaces/:slug/workforce/patterns/:id/end": "token-ok",
  "GET /v1/workspaces/:slug/workforce/rota": "token-ok",
  "GET /v1/workspaces/:slug/workforce/rota/me": "token-ok",
  "POST /v1/workspaces/:slug/workforce/rota/entries": "token-ok",
  "POST /v1/workspaces/:slug/workforce/rota/entries/:id/cancel": "token-ok",
  "POST /v1/workspaces/:slug/workforce/rota/generate": "token-ok",
  "GET /v1/workspaces/:slug/workforce/agencies": "token-ok",
  "POST /v1/workspaces/:slug/workforce/agencies": "token-ok",
  "PATCH /v1/workspaces/:slug/workforce/agencies/:id": "token-ok",
  "POST /v1/workspaces/:slug/workforce/agency-engagements": "token-ok",
  "POST /v1/workspaces/:slug/workforce/agency-engagements/:id/end": "token-ok",
  "GET /v1/workspaces/:slug/workforce/staffing/requirements": "token-ok",
  "POST /v1/workspaces/:slug/workforce/staffing/requirements": "token-ok",
  "PATCH /v1/workspaces/:slug/workforce/staffing/requirements/:id": "token-ok",
  "GET /v1/workspaces/:slug/workforce/staffing": "token-ok",
  "GET /v1/workspaces/:slug/accounting/connections": "token-forbidden",
  "POST /v1/workspaces/:slug/accounting/connections": "token-forbidden",
  "GET /v1/workspaces/:slug/accounting/references": "token-forbidden",
  "GET /v1/workspaces/:slug/accounting/connections/:id": "token-forbidden",
  "PATCH /v1/workspaces/:slug/accounting/connections/:id": "token-forbidden",
  "PUT /v1/workspaces/:slug/accounting/connections/:id/mappings": "token-forbidden",
  "GET /v1/workspaces/:slug/accounting/connections/:id/xero": "token-forbidden",
  "POST /v1/workspaces/:slug/accounting/connections/:id/xero/start": "token-forbidden",
  "POST /v1/workspaces/:slug/accounting/connections/:id/xero/review": "token-forbidden",
  "POST /v1/workspaces/:slug/accounting/connections/:id/xero/confirm": "token-forbidden",
  "POST /v1/workspaces/:slug/accounting/connections/:id/xero/verify": "token-forbidden",
  "POST /v1/workspaces/:slug/accounting/connections/:id/xero/disconnect": "token-forbidden",
  "GET /v1/accounting/xero/callback": "token-forbidden",
  "GET /v1/workspaces/:slug/accounting/connections/:id/history": "token-forbidden",
  "GET /v1/workspaces/:slug/accounting/connections/:id/postings": "token-forbidden",
  "GET /v1/workspaces/:slug/accounting/connections/:id/postings/:postingId": "token-forbidden",
  "POST /v1/workspaces/:slug/accounting/connections/:id/postings/:postingId/send": "token-forbidden",
  "POST /v1/workspaces/:slug/accounting/connections/:id/postings/:postingId/retry": "token-forbidden",
  "POST /v1/workspaces/:slug/accounting/connections/:id/postings/:postingId/read-back": "token-forbidden",
  "POST /v1/workspaces/:slug/accounting/connections/:id/postings/:postingId/allocation": "token-forbidden",
  "GET /v1/workspaces/:slug/accounting/connections/:id/customer-documents": "token-forbidden",
  "GET /v1/workspaces/:slug/accounting/connections/:id/customer-documents/:invoiceId": "token-forbidden",
  "POST /v1/workspaces/:slug/accounting/connections/:id/customer-documents/:invoiceId/prepare":
    "token-forbidden",
  "GET /v1/workspaces/:slug/accounting/connections/:id/purchase-invoices": "token-forbidden",
  "GET /v1/workspaces/:slug/accounting/connections/:id/purchase-invoices/:invoiceId": "token-forbidden",
  "POST /v1/workspaces/:slug/accounting/connections/:id/purchase-invoices/:invoiceId/prepare":
    "token-forbidden",
  "GET /v1/workspaces/:slug/hse/registers": "token-ok",
  "GET /v1/workspaces/:slug/hse/registers/:id": "token-ok",
  "GET /v1/workspaces/:slug/hse/registers/:id/history": "token-ok",
  "GET /v1/workspaces/:slug/hse/registers/:id/entries": "token-ok",
  "GET /v1/workspaces/:slug/hse/permits": "token-ok",
  "GET /v1/workspaces/:slug/hse/permits/:id": "token-ok",
  "GET /v1/workspaces/:slug/hse/permits/:id/history": "token-ok",
  "POST /v1/workspaces/:slug/hse/registers": "token-ok",
  "PUT /v1/workspaces/:slug/hse/registers/:id/draft": "token-ok",
  "POST /v1/workspaces/:slug/hse/registers/:id/review": "token-ok",
  "POST /v1/workspaces/:slug/hse/permits": "token-ok",
  "PUT /v1/workspaces/:slug/hse/permits/:id": "token-ok",
  "POST /v1/workspaces/:slug/hse/registers/:id/approve": "token-forbidden",
  "POST /v1/workspaces/:slug/hse/registers/:id/archive": "token-forbidden",
  "POST /v1/workspaces/:slug/hse/registers/:id/entries": "token-forbidden",
  "POST /v1/workspaces/:slug/hse/registers/:id/entries/:entryId/void": "token-forbidden",
  "POST /v1/workspaces/:slug/hse/permits/:id/issue": "token-forbidden",
  "POST /v1/workspaces/:slug/hse/permits/:id/suspend": "token-forbidden",
  "POST /v1/workspaces/:slug/hse/permits/:id/resume": "token-forbidden",
  "POST /v1/workspaces/:slug/hse/permits/:id/close": "token-forbidden",
  "POST /v1/workspaces/:slug/hse/permits/:id/cancel": "token-forbidden",
  "GET /v1/workspaces/:slug/hse/incidents": "token-forbidden",
  "POST /v1/workspaces/:slug/hse/incidents": "token-forbidden",
  "GET /v1/workspaces/:slug/hse/incidents/:id": "token-forbidden",
  "PUT /v1/workspaces/:slug/hse/incidents/:id": "token-forbidden",
  "GET /v1/workspaces/:slug/hse/incidents/:id/history": "token-forbidden",
  "POST /v1/workspaces/:slug/hse/incidents/:id/close": "token-forbidden",
  "GET /v1/workspaces/:slug/hse/incidents/overview": "token-forbidden",
  "POST /v1/workspaces/:slug/hse/incidents/:id/actions": "token-forbidden",
  "POST /v1/workspaces/:slug/hse/incidents/:id/actions/:actionId/complete": "token-forbidden",
  "PUT /v1/workspaces/:slug/hse/incidents/:id/injuries": "token-forbidden",
  "POST /v1/workspaces/:slug/hse/reports": "token-ok",

  "GET /v1/workspaces/:slug/sales/orders": "token-ok",
  "POST /v1/workspaces/:slug/sales/orders": "token-ok",
  "GET /v1/workspaces/:slug/sales/orders/:id": "token-ok",
  "PUT /v1/workspaces/:slug/sales/orders/:id": "token-ok",
  "GET /v1/workspaces/:slug/sales/orders/:id/history": "token-ok",
  "GET /v1/workspaces/:slug/sales/orders/:id/fulfilments": "token-ok",
  "GET /v1/workspaces/:slug/sales/prices": "token-ok",
  "GET /v1/workspaces/:slug/sales/commitments": "token-ok",
  "GET /v1/workspaces/:slug/sales/integration": "token-ok",
  "POST /v1/workspaces/:slug/sales/integration/references": "token-ok",
  "POST /v1/workspaces/:slug/sales/orders/:id/amend": "token-forbidden",
  "POST /v1/workspaces/:slug/sales/orders/:id/confirm": "token-forbidden",
  "POST /v1/workspaces/:slug/sales/orders/:id/issue": "token-forbidden",
  "POST /v1/workspaces/:slug/sales/orders/:id/cancel": "token-forbidden",
  "POST /v1/workspaces/:slug/sales/orders/:id/convert": "token-forbidden",
  "POST /v1/workspaces/:slug/sales/orders/:id/fulfilments": "token-forbidden",
  "POST /v1/workspaces/:slug/sales/orders/:id/fulfilments/:linkId/void": "token-forbidden",
  "POST /v1/workspaces/:slug/sales/prices": "token-forbidden",
  "POST /v1/workspaces/:slug/sales/prices/:id/archive": "token-forbidden",

  "GET /v1/workspaces/:slug/quality/authenticity": "token-ok",
  "POST /v1/workspaces/:slug/quality/authenticity": "token-ok",
  "GET /v1/workspaces/:slug/quality/authenticity/:id": "token-ok",
  "POST /v1/workspaces/:slug/quality/authenticity/:id/draft": "token-ok",
  "PUT /v1/workspaces/:slug/quality/authenticity/:id/draft": "token-ok",
  "POST /v1/workspaces/:slug/quality/authenticity/:id/triggers": "token-ok",
  "POST /v1/workspaces/:slug/quality/authenticity/:id/approve": "token-forbidden",
  "POST /v1/workspaces/:slug/quality/authenticity/:id/versions/:versionId/controls/:controlId/verify":
    "token-forbidden",
  "POST /v1/workspaces/:slug/quality/authenticity/:id/verifications/:verificationId/void": "token-forbidden",
  "POST /v1/workspaces/:slug/quality/authenticity/:id/archive": "token-forbidden",

  "GET /v1/workspaces/:slug/customers/:id/sites": "token-ok",
  "POST /v1/workspaces/:slug/customers/:id/sites": "token-ok",
  "PUT /v1/workspaces/:slug/customers/:id/sites/:siteId": "token-ok",
  "GET /v1/workspaces/:slug/despatch/:id/operations": "token-ok",
  "POST /v1/workspaces/:slug/despatch/:id/allocate": "token-forbidden",
  "POST /v1/workspaces/:slug/despatch/:id/unallocate": "token-forbidden",
  "POST /v1/workspaces/:slug/despatch/:id/pack": "token-forbidden",
  "POST /v1/workspaces/:slug/despatch/:id/load-check": "token-forbidden",
  "POST /v1/workspaces/:slug/despatch/:id/proof": "token-forbidden",
  "POST /v1/workspaces/:slug/despatch/:id/returns": "token-forbidden",
  "POST /v1/workspaces/:slug/despatch/:id/returns/:returnId/void": "token-forbidden",

  "GET /v1/workspaces/:slug/quality/incidents": "token-ok",
  "POST /v1/workspaces/:slug/quality/incidents": "token-ok",
  "GET /v1/workspaces/:slug/quality/incidents/:id": "token-ok",
  "POST /v1/workspaces/:slug/quality/incidents/:id/contain": "token-forbidden",
  "POST /v1/workspaces/:slug/quality/incidents/:id/events": "token-forbidden",
  "POST /v1/workspaces/:slug/quality/incidents/:id/release": "token-forbidden",
  "POST /v1/workspaces/:slug/quality/incidents/:id/close": "token-forbidden",

  "GET /v1/workspaces/:slug/despatch/lots/:lotId/impact": "token-ok",
  "GET /v1/workspaces/:slug/despatch/lots/:lotId/impact.csv": "token-ok",
  "GET /v1/workspaces/:slug/customers": "token-ok",
  "POST /v1/workspaces/:slug/customers": "token-ok",
  "GET /v1/workspaces/:slug/customers/:id": "token-ok",
  "PATCH /v1/workspaces/:slug/customers/:id": "token-ok",
  "GET /v1/workspaces/:slug/despatch": "token-ok",
  "POST /v1/workspaces/:slug/despatch": "token-ok",
  "GET /v1/workspaces/:slug/despatch/:id": "token-ok",
  "PUT /v1/workspaces/:slug/despatch/:id": "token-ok",
  "GET /v1/workspaces/:slug/despatch/lots/:lotId/recipients": "token-ok",
  "POST /v1/workspaces/:slug/despatch/:id/confirm": "token-forbidden",
  "POST /v1/workspaces/:slug/despatch/:id/void": "token-forbidden",
  // Better Auth: sign-in sessions only. `app.use("/api/auth/*")` refuses tokens.
  "GET /api/auth/*": "token-forbidden",
  "POST /api/auth/*": "token-forbidden",

  // Login config, first-run setup and invitation acceptance: no session.
  "GET /v1/public/auth-config": "public",
  "POST /v1/public/setup": "public",
  "GET /v1/public/invitations/:token": "public",
  "POST /v1/public/invitations/:token/accept": "public",
  // Kiosk pairing: the one-time pairing code is the credential.
  "POST /v1/public/kiosk/pair": "public",
  // A signed attachment download link: the signature is the credential (re-checked against the person's access).
  "GET /v1/public/attachment-links/:token": "public",

  // The attendance kiosk (routes/kiosk.ts).
  "GET /v1/kiosk/session": "device",
  "POST /v1/kiosk/identify": "device",
  "POST /v1/kiosk/clock": "device",
  "POST /v1/kiosk/pin": "device",
  "POST /v1/kiosk/visitors/sign-in": "device",
  "POST /v1/kiosk/visitors/sign-out": "device",
  "GET /v1/kiosk/hosts": "device",
  "POST /v1/kiosk/sops/:id/read": "device",
  "POST /v1/kiosk/sops/:id/acknowledge": "device",
  "POST /v1/kiosk/replay": "device",

  // Assistant provider API keys and preferences (routes/assistant.ts): a sign-in session only, so
  // nothing holding a token can read, replace or spend a member's key.
  "GET /v1/me/assistant/keys": "token-forbidden",
  "PUT /v1/me/assistant/keys/:provider": "token-forbidden",
  "PATCH /v1/me/assistant/keys/:provider": "token-forbidden",
  "DELETE /v1/me/assistant/keys/:provider": "token-forbidden",
  "GET /v1/me/assistant/keys/:provider/models": "token-forbidden",
  "GET /v1/me/assistant/settings": "token-forbidden",
  "PATCH /v1/me/assistant/settings": "token-forbidden",
  // The assistant spends the member's own AI subscription and holds personal chats: never a token.
  "GET /v1/workspaces/:slug/assistant/status": "token-forbidden",
  "GET /v1/workspaces/:slug/assistant/conversations": "token-forbidden",
  "POST /v1/workspaces/:slug/assistant/conversations": "token-forbidden",
  "GET /v1/workspaces/:slug/assistant/conversations/:id": "token-forbidden",
  "PATCH /v1/workspaces/:slug/assistant/conversations/:id": "token-forbidden",
  "DELETE /v1/workspaces/:slug/assistant/conversations/:id": "token-forbidden",
  "POST /v1/workspaces/:slug/assistant/conversations/:id/messages": "token-forbidden",
  "POST /v1/workspaces/:slug/assistant/conversations/:id/cancel": "token-forbidden",
  "GET /v1/workspaces/:slug/assistant/stream": "token-forbidden",

  "GET /v1/me": "token-ok",
  // Token management: a real sign-in session only, so a leaked token can't mint more.
  "GET /v1/me/api-tokens": "token-forbidden",
  "POST /v1/me/api-tokens": "token-forbidden",
  "PATCH /v1/me/api-tokens/:id": "token-forbidden",
  "DELETE /v1/me/api-tokens/:id": "token-forbidden",

  // Personal calendar connections and events.
  "GET /v1/calendar/connections": "token-forbidden",
  "POST /v1/calendar/connections/activate": "token-forbidden",
  "POST /v1/calendar/connections/:id/sync": "token-forbidden",
  "DELETE /v1/calendar/connections/:id": "token-forbidden",
  "GET /v1/workspaces/:slug/calendar": "token-forbidden",

  // Workspace data.
  "GET /v1/workspaces/:slug/bootstrap": "token-ok",
  "GET /v1/workspaces/:slug/sync": "token-ok",
  "GET /v1/workspaces/:slug/events": "token-ok",
  "GET /v1/workspaces/:slug/search": "token-ok",
  // The active modules and the caller's own level in each: what an agent needs to pick its tools.
  "GET /v1/workspaces/:slug/modules": "token-ok",
  "GET /v1/workspaces/:slug/module-settings": "token-forbidden",
  "PATCH /v1/workspaces/:slug/module-settings": "token-forbidden",
  // The workspace time zone: agents need it to read and send dates. Changing it is admin-only.
  "GET /v1/workspaces/:slug/settings": "token-ok",
  "GET /v1/workspaces/:slug/purchase-requests": "token-ok",
  "GET /v1/workspaces/:slug/purchase-requests/:id": "token-ok",
  "POST /v1/workspaces/:slug/purchase-requests": "token-ok",
  "POST /v1/workspaces/:slug/purchase-requests/:id/decision": "token-forbidden",
  // Routings: an agent may keep work centres and routings, make job cards and record work on them
  // (time, quantities, exceptions, completion, materials and output). Approving a routing version
  // is a person's sign-off; voiding job card time or quantities is a person's correction.
  "GET /v1/workspaces/:slug/routings/work-centres": "token-ok",
  "POST /v1/workspaces/:slug/routings/work-centres": "token-ok",
  "GET /v1/workspaces/:slug/routings/work-centres/:id": "token-ok",
  "PATCH /v1/workspaces/:slug/routings/work-centres/:id": "token-ok",
  "GET /v1/workspaces/:slug/routings/batches/:batchId/job-cards": "token-ok",
  "POST /v1/workspaces/:slug/routings/batches/:batchId/job-cards": "token-ok",
  "DELETE /v1/workspaces/:slug/routings/batches/:batchId/job-cards": "token-ok",
  "GET /v1/workspaces/:slug/routings/job-cards": "token-ok",
  "GET /v1/workspaces/:slug/routings/job-cards/:id": "token-ok",
  "POST /v1/workspaces/:slug/routings/job-cards/:id/timer/start": "token-ok",
  "POST /v1/workspaces/:slug/routings/job-cards/:id/timer/stop": "token-ok",
  "POST /v1/workspaces/:slug/routings/job-cards/:id/time": "token-ok",
  "POST /v1/workspaces/:slug/routings/job-cards/:id/time/:logId/void": "token-forbidden",
  "POST /v1/workspaces/:slug/routings/job-cards/:id/quantities": "token-ok",
  "POST /v1/workspaces/:slug/routings/job-cards/:id/quantities/:entryId/void": "token-forbidden",
  "POST /v1/workspaces/:slug/routings/job-cards/:id/exceptions": "token-ok",
  "POST /v1/workspaces/:slug/routings/job-cards/:id/exceptions/:exceptionId/resolve": "token-forbidden",
  "POST /v1/workspaces/:slug/routings/job-cards/:id/complete": "token-ok",
  "POST /v1/workspaces/:slug/routings/job-cards/:id/consumption": "token-ok",
  "POST /v1/workspaces/:slug/routings/job-cards/:id/output": "token-ok",
  "GET /v1/workspaces/:slug/routings": "token-ok",
  "POST /v1/workspaces/:slug/routings": "token-ok",
  "GET /v1/workspaces/:slug/routings/:id": "token-ok",
  "PATCH /v1/workspaces/:slug/routings/:id": "token-ok",
  "PUT /v1/workspaces/:slug/routings/:id/draft": "token-ok",
  "DELETE /v1/workspaces/:slug/routings/:id/draft": "token-ok",
  "POST /v1/workspaces/:slug/routings/:id/draft/approve": "token-forbidden",
  "DELETE /v1/workspaces/:slug/routings/:id": "token-ok",
  "GET /v1/workspaces/:slug/assets": "token-ok",
  "POST /v1/workspaces/:slug/assets": "token-ok",
  "GET /v1/workspaces/:slug/assets/:id": "token-ok",
  "PATCH /v1/workspaces/:slug/assets/:id": "token-ok",
  "POST /v1/workspaces/:slug/assets/:id/archive": "token-ok",
  "POST /v1/workspaces/:slug/assets/:id/restore": "token-ok",
  "GET /v1/workspaces/:slug/invoicing": "token-ok",
  "POST /v1/workspaces/:slug/invoicing": "token-ok",
  "GET /v1/workspaces/:slug/invoicing/settings": "token-ok",
  "PUT /v1/workspaces/:slug/invoicing/settings": "token-forbidden",
  "GET /v1/workspaces/:slug/invoicing/:id": "token-ok",
  "PATCH /v1/workspaces/:slug/invoicing/:id": "token-ok",
  "POST /v1/workspaces/:slug/invoicing/:id/decision": "token-forbidden",
  "GET /v1/workspaces/:slug/invoicing/:id/pdf": "token-ok",
  "GET /v1/workspaces/:slug/client-services": "token-ok",
  "POST /v1/workspaces/:slug/client-services": "token-ok",
  "GET /v1/workspaces/:slug/client-services/:id": "token-ok",
  "PATCH /v1/workspaces/:slug/client-services/:id": "token-ok",
  "POST /v1/workspaces/:slug/client-services/:id/decision": "token-forbidden",
  "GET /v1/workspaces/:slug/client-services/:id/billing-draft.csv": "token-ok",
  "GET /v1/workspaces/:slug/crm/stages": "token-ok",
  "PUT /v1/workspaces/:slug/crm/stages": "token-ok",
  "GET /v1/workspaces/:slug/crm/pipeline": "token-ok",
  "GET /v1/workspaces/:slug/crm/leads": "token-ok",
  "POST /v1/workspaces/:slug/crm/leads": "token-ok",
  "GET /v1/workspaces/:slug/crm/leads/:id": "token-ok",
  "PATCH /v1/workspaces/:slug/crm/leads/:id": "token-ok",
  "POST /v1/workspaces/:slug/crm/leads/:id/convert": "token-ok",
  "GET /v1/workspaces/:slug/crm/opportunities": "token-ok",
  "POST /v1/workspaces/:slug/crm/opportunities": "token-ok",
  "GET /v1/workspaces/:slug/crm/opportunities/:id": "token-ok",
  "PATCH /v1/workspaces/:slug/crm/opportunities/:id": "token-ok",
  "GET /v1/workspaces/:slug/crm/opportunities/:id/quote-options": "token-ok",
  "POST /v1/workspaces/:slug/crm/opportunities/:id/outcome": "token-ok",
  "POST /v1/workspaces/:slug/crm/opportunities/:id/handoff": "token-forbidden",
  "GET /v1/workspaces/:slug/crm/activities": "token-ok",
  "POST /v1/workspaces/:slug/crm/activities": "token-ok",
  "PATCH /v1/workspaces/:slug/crm/activities/:id": "token-ok",
  "PATCH /v1/workspaces/:slug/settings": "token-forbidden",
  "GET /v1/workspaces/:slug/tasks": "token-ok",
  "GET /v1/workspaces/:slug/tasks/views": "token-ok",
  "POST /v1/workspaces/:slug/tasks/views": "token-ok",
  "GET /v1/workspaces/:slug/tasks/views/:id": "token-ok",
  "PATCH /v1/workspaces/:slug/tasks/views/:id": "token-ok",
  "DELETE /v1/workspaces/:slug/tasks/views/:id": "token-ok",
  "GET /v1/workspaces/:slug/tasks/:id": "token-ok",
  "GET /v1/workspaces/:slug/tasks/:id/backlinks": "token-ok",
  "GET /v1/workspaces/:slug/tasks/:id/activity": "token-ok",
  "GET /v1/workspaces/:slug/tasks/:id/links": "token-ok",
  "POST /v1/workspaces/:slug/tasks/:id/links": "token-ok",
  "DELETE /v1/workspaces/:slug/tasks/:id/links/:linkId": "token-ok",
  "GET /v1/workspaces/:slug/tasks/:id/following": "token-ok",
  "PUT /v1/workspaces/:slug/tasks/:id/following": "token-ok",
  "POST /v1/workspaces/:slug/tasks": "token-ok",
  "POST /v1/workspaces/:slug/tasks/bulk": "token-ok",
  "POST /v1/workspaces/:slug/tasks/:id/duplicate": "token-ok",
  "PATCH /v1/workspaces/:slug/tasks/:id": "token-ok",
  "DELETE /v1/workspaces/:slug/tasks/:id": "token-ok",
  "POST /v1/workspaces/:slug/task-relations": "token-ok",
  "DELETE /v1/workspaces/:slug/task-relations/:id": "token-ok",
  "GET /v1/workspaces/:slug/tasks/:id/comments": "token-ok",
  "POST /v1/workspaces/:slug/tasks/:id/comments": "token-ok",
  "PATCH /v1/workspaces/:slug/comments/:id": "token-ok",
  "DELETE /v1/workspaces/:slug/comments/:id": "token-ok",
  // Time tracking: workspace data. Members act on their own entries and timer; admin overrides
  // (logging or editing others' time) are role checks in the service, as for comments.
  "GET /v1/workspaces/:slug/tasks/:id/time-entries": "token-ok",
  "POST /v1/workspaces/:slug/tasks/:id/time-entries": "token-ok",
  "PATCH /v1/workspaces/:slug/time-entries/:id": "token-ok",
  "DELETE /v1/workspaces/:slug/time-entries/:id": "token-ok",
  "POST /v1/workspaces/:slug/tasks/:id/timer": "token-ok",
  "POST /v1/workspaces/:slug/timer/stop": "token-ok",
  "GET /v1/workspaces/:slug/projects/:id/time": "token-ok",
  // Attachments: workspace data. A read token may download; uploads and deletes need write scope
  // (and a non-guest role).
  // GET lists a module record's files (needs read on its module); POST/DELETE check write/manage there.
  "GET /v1/workspaces/:slug/attachments": "token-ok",
  "POST /v1/workspaces/:slug/attachments": "token-ok",
  "GET /v1/workspaces/:slug/attachments/:id": "token-ok",
  "GET /v1/workspaces/:slug/attachments/:id/content": "token-ok",
  // A signed download link for an agent to hand on: it needs the same `read` as the bytes.
  "GET /v1/workspaces/:slug/attachments/:id/link": "token-ok",
  "POST /v1/workspaces/:slug/attachments/:id/replace": "token-ok",
  "DELETE /v1/workspaces/:slug/attachments/:id": "token-ok",
  "GET /v1/workspaces/:slug/tasks/:id/attachments": "token-ok",
  // Time reports: read-only aggregates of data every member can already read (see routes/reports.ts).
  "GET /v1/workspaces/:slug/time-report": "token-ok",
  "GET /v1/workspaces/:slug/time-report.csv": "token-ok",
  "GET /v1/workspaces/:slug/projects": "token-ok",
  "GET /v1/workspaces/:slug/projects/:id/updates": "token-ok",
  "POST /v1/workspaces/:slug/projects/:id/updates": "token-ok",
  "GET /v1/workspaces/:slug/projects/:id/updates/:updateId/comments": "token-ok",
  "POST /v1/workspaces/:slug/projects/:id/updates/:updateId/comments": "token-ok",
  "GET /v1/workspaces/:slug/projects/:id/members": "token-ok",
  "POST /v1/workspaces/:slug/projects/:id/members": "token-ok",
  "DELETE /v1/workspaces/:slug/projects/:id/members/:userId": "token-ok",
  "PUT /v1/workspaces/:slug/projects/:id/following": "token-ok",
  "GET /v1/workspaces/:slug/projects/:id/milestones": "token-ok",
  "POST /v1/workspaces/:slug/projects/:id/milestones": "token-ok",
  "PATCH /v1/workspaces/:slug/projects/:id/milestones/:milestoneId": "token-ok",
  "DELETE /v1/workspaces/:slug/projects/:id/milestones/:milestoneId": "token-ok",
  "GET /v1/workspaces/:slug/projects/:id/sections": "token-ok",
  "POST /v1/workspaces/:slug/projects/:id/sections": "token-ok",
  "PATCH /v1/workspaces/:slug/projects/:id/sections/:sectionId": "token-ok",
  "DELETE /v1/workspaces/:slug/projects/:id/sections/:sectionId": "token-ok",
  "POST /v1/workspaces/:slug/projects": "token-ok",
  "POST /v1/workspaces/:slug/projects/from-template": "token-ok",
  "PATCH /v1/workspaces/:slug/projects/:id": "token-ok",
  "DELETE /v1/workspaces/:slug/projects/:id": "token-ok",
  "GET /v1/workspaces/:slug/documents": "token-ok",
  "GET /v1/workspaces/:slug/documents/:id": "token-ok",
  "GET /v1/workspaces/:slug/documents/:id/backlinks": "token-ok",
  "POST /v1/workspaces/:slug/documents": "token-ok",
  "PATCH /v1/workspaces/:slug/documents/:id": "token-ok",
  "DELETE /v1/workspaces/:slug/documents/:id": "token-ok",
  // Version history: workspace data, read like the document itself. Restore is token-ok because an
  // agent with a write token can already PATCH any document to any content; restoring a revision is a
  // narrower, reversible version of that (it snapshots the current state as "before-restore" first,
  // honours expectedUpdatedAt, and requireSession keeps read-scope tokens off it).
  "GET /v1/workspaces/:slug/documents/:id/revisions": "token-ok",
  "GET /v1/workspaces/:slug/documents/:id/revisions/:revisionId": "token-ok",
  "POST /v1/workspaces/:slug/documents/:id/revisions/:revisionId/restore": "token-ok",
  "GET /v1/workspaces/:slug/members": "token-ok",

  // Items module: master data an agent may read and maintain. Supplier approval is a food-safety
  // sign-off by a person (`forbidTokens` + `manage`).
  "GET /v1/workspaces/:slug/items": "token-ok",
  "GET /v1/workspaces/:slug/items/:id": "token-ok",
  "POST /v1/workspaces/:slug/items": "token-ok",
  "POST /v1/workspaces/:slug/items/import": "token-ok",
  "PATCH /v1/workspaces/:slug/items/:id": "token-ok",
  "DELETE /v1/workspaces/:slug/items/:id": "token-ok",
  "GET /v1/workspaces/:slug/suppliers": "token-ok",
  "GET /v1/workspaces/:slug/suppliers/:id": "token-ok",
  "POST /v1/workspaces/:slug/suppliers": "token-ok",
  "POST /v1/workspaces/:slug/suppliers/import": "token-ok",
  "PATCH /v1/workspaces/:slug/suppliers/:id": "token-ok",
  "DELETE /v1/workspaces/:slug/suppliers/:id": "token-ok",
  "POST /v1/workspaces/:slug/suppliers/:id/approval": "token-forbidden",
  "GET /v1/workspaces/:slug/suppliers/control-settings": "token-ok",
  "PUT /v1/workspaces/:slug/suppliers/control-settings": "token-forbidden",
  "GET /v1/workspaces/:slug/suppliers/compliance": "token-ok",
  "GET /v1/workspaces/:slug/suppliers/:id/controls": "token-ok",
  "POST /v1/workspaces/:slug/suppliers/:id/risk-assessments": "token-forbidden",
  "POST /v1/workspaces/:slug/suppliers/:id/questionnaires": "token-ok",
  "POST /v1/workspaces/:slug/suppliers/:id/questionnaires/:questionnaireId/receive": "token-ok",
  "POST /v1/workspaces/:slug/suppliers/:id/questionnaires/:questionnaireId/review": "token-forbidden",
  // Stock. Waste, adjustments, lot status, stocktakes and reversals destroy or sign off stock:
  // a signed-in person only.
  "GET /v1/workspaces/:slug/stock/locations": "token-ok",
  "POST /v1/workspaces/:slug/stock/locations": "token-ok",
  "PATCH /v1/workspaces/:slug/stock/locations/:id": "token-ok",
  "GET /v1/workspaces/:slug/stock/levels": "token-ok",
  "GET /v1/workspaces/:slug/stock/lots": "token-ok",
  "GET /v1/workspaces/:slug/stock/lots/:id": "token-ok",
  "GET /v1/workspaces/:slug/stock/movements": "token-ok",
  "GET /v1/workspaces/:slug/stock/items/:itemId/pick": "token-ok",
  "POST /v1/workspaces/:slug/stock/receipts": "token-ok",
  "POST /v1/workspaces/:slug/stock/transfers": "token-ok",
  "POST /v1/workspaces/:slug/stock/waste": "token-action",
  "POST /v1/workspaces/:slug/stock/adjustments": "token-action",
  "POST /v1/workspaces/:slug/stock/lots/:id/status": "token-forbidden",
  "GET /v1/workspaces/:slug/stock/lots/:id/release-check": "token-ok",
  "GET /v1/workspaces/:slug/stock/lots/:id/releases": "token-ok",
  "GET /v1/workspaces/:slug/stock/lots/:id/release-exceptions": "token-ok",
  "POST /v1/workspaces/:slug/stock/lots/:id/release-exceptions": "token-forbidden",
  "POST /v1/workspaces/:slug/stock/lots/:id/release-exceptions/:requestId/approve": "token-forbidden",
  "POST /v1/workspaces/:slug/stock/lots/:id/release-exceptions/:requestId/reject": "token-forbidden",
  "GET /v1/workspaces/:slug/stock/release-rules": "token-ok",
  "PUT /v1/workspaces/:slug/stock/release-rules/:itemId": "token-forbidden",
  "DELETE /v1/workspaces/:slug/stock/release-rules/:itemId": "token-forbidden",
  "POST /v1/workspaces/:slug/stock/stocktakes": "token-action",
  "POST /v1/workspaces/:slug/stock/movements/:id/reverse": "token-forbidden",
  // Production. Agents may read, plan and record; completing a batch is a sign-off (`manage` and
  // a person), and corrections and cancellations are a person's act.
  "GET /v1/workspaces/:slug/production/batches": "token-ok",
  "GET /v1/workspaces/:slug/production/batches/:id": "token-ok",
  "GET /v1/workspaces/:slug/production/batches/:id/readiness": "token-ok",
  "GET /v1/workspaces/:slug/production/batches/:id/pick": "token-ok",
  "GET /v1/workspaces/:slug/production/requirements": "token-ok",
  "GET /v1/workspaces/:slug/production/lines": "token-ok",
  "GET /v1/workspaces/:slug/production/schedule": "token-ok",
  "GET /v1/workspaces/:slug/production/schedule/day": "token-ok",
  "PUT /v1/workspaces/:slug/production/schedule/sequence": "token-ok",
  "GET /v1/workspaces/:slug/production/daily-demand": "token-ok",
  "PUT /v1/workspaces/:slug/production/lines/:id/shifts": "token-ok",
  "PUT /v1/workspaces/:slug/production/lines/:id/changeovers": "token-ok",
  "GET /v1/workspaces/:slug/production/reservations": "token-ok",
  "GET /v1/workspaces/:slug/production/availability": "token-ok",
  "GET /v1/workspaces/:slug/production/batches/:id/scan": "token-ok",
  "POST /v1/workspaces/:slug/production/batches/:id/reservations": "token-ok",
  "POST /v1/workspaces/:slug/production/reservations/:id/release": "token-ok",
  "PATCH /v1/workspaces/:slug/production/reservations/:id": "token-ok",
  "GET /v1/workspaces/:slug/production/calendar": "token-ok",
  "POST /v1/workspaces/:slug/production/calendar": "token-ok",
  "DELETE /v1/workspaces/:slug/production/calendar/:id": "token-ok",
  "GET /v1/workspaces/:slug/demand/capacity": "token-ok",
  "POST /v1/workspaces/:slug/production/lines": "token-ok",
  "PATCH /v1/workspaces/:slug/production/lines/:id": "token-ok",
  "PUT /v1/workspaces/:slug/production/lines/:id/recipes/:recipeId": "token-ok",
  "DELETE /v1/workspaces/:slug/production/lines/:id/recipes/:recipeId": "token-ok",
  "GET /v1/workspaces/:slug/production/lots/:lotId/trace": "token-ok",
  // Planning from demand: a proposal on read, then ordinary batch creation (not a sign-off).
  "GET /v1/workspaces/:slug/production/plan-from-demand": "token-ok",
  "POST /v1/workspaces/:slug/production/plan-from-demand": "token-ok",
  "POST /v1/workspaces/:slug/production/batches": "token-ok",
  "PATCH /v1/workspaces/:slug/production/batches/:id": "token-ok",
  "POST /v1/workspaces/:slug/production/batches/:id/start": "token-ok",
  "POST /v1/workspaces/:slug/production/batches/:id/consumption": "token-ok",
  "POST /v1/workspaces/:slug/production/batches/:id/output": "token-ok",
  "POST /v1/workspaces/:slug/production/batches/:id/records/:recordId/reverse": "token-forbidden",
  "GET /v1/workspaces/:slug/production/performance": "token-ok",
  "GET /v1/workspaces/:slug/production/downtime": "token-ok",
  "GET /v1/workspaces/:slug/production/batches/:id/performance": "token-ok",
  "POST /v1/workspaces/:slug/production/downtime": "token-ok",
  "POST /v1/workspaces/:slug/production/batches/:id/rejects": "token-ok",
  "POST /v1/workspaces/:slug/production/batches/:id/labour": "token-ok",
  "POST /v1/workspaces/:slug/production/downtime/:id/void": "token-forbidden",
  "POST /v1/workspaces/:slug/production/rejects/:id/void": "token-forbidden",
  "POST /v1/workspaces/:slug/production/labour/:id/void": "token-forbidden",
  "GET /v1/workspaces/:slug/production/batches/:id/packing": "token-ok",
  "GET /v1/workspaces/:slug/production/devices": "token-ok",
  "GET /v1/workspaces/:slug/production/devices/:id/readings": "token-ok",
  "POST /v1/workspaces/:slug/production/devices": "token-ok",
  "PATCH /v1/workspaces/:slug/production/devices/:id": "token-ok",
  "POST /v1/workspaces/:slug/production/devices/:id/readings": "token-ok",
  "POST /v1/workspaces/:slug/production/packing/:id/checks/weight-from-device": "token-ok",
  "GET /v1/workspaces/:slug/production/lots/:lotId/packing": "token-ok",
  "POST /v1/workspaces/:slug/production/batches/:id/packing": "token-ok",
  "POST /v1/workspaces/:slug/production/packing/:id/checks": "token-ok",
  "POST /v1/workspaces/:slug/production/packing/:id/close": "token-forbidden",
  "POST /v1/workspaces/:slug/production/packing/checks/:id/void": "token-forbidden",
  "GET /v1/workspaces/:slug/governance/standards": "token-ok",
  "GET /v1/workspaces/:slug/governance/standards/:id": "token-ok",
  "GET /v1/workspaces/:slug/governance/standards/:id/report.csv": "token-ok",
  "GET /v1/workspaces/:slug/governance/clauses/:id": "token-ok",
  "POST /v1/workspaces/:slug/governance/standards": "token-ok",
  "PATCH /v1/workspaces/:slug/governance/standards/:id": "token-ok",
  "POST /v1/workspaces/:slug/governance/standards/:id/clauses/import": "token-ok",
  "POST /v1/workspaces/:slug/governance/clauses/:id/assessments": "token-forbidden",
  "POST /v1/workspaces/:slug/governance/clauses/:id/tasks": "token-ok",
  "GET /v1/workspaces/:slug/governance/evidence-checks": "token-ok",
  "PUT /v1/workspaces/:slug/governance/clauses/:id/evidence": "token-ok",
  "POST /v1/workspaces/:slug/governance/clauses/:id/drafts": "token-ok",
  "POST /v1/workspaces/:slug/governance/drafts/:id/accept": "token-forbidden",
  "POST /v1/workspaces/:slug/governance/drafts/:id/dismiss": "token-ok",
  "GET /v1/workspaces/:slug/governance/standards/:id/snapshots": "token-ok",
  "POST /v1/workspaces/:slug/governance/standards/:id/snapshots": "token-ok",
  "GET /v1/workspaces/:slug/governance/snapshots/:id": "token-ok",
  "GET /v1/workspaces/:slug/governance/snapshots/:id/report.csv": "token-ok",
  "POST /v1/workspaces/:slug/production/batches/:id/cancel": "token-action",
  "POST /v1/workspaces/:slug/production/batches/:id/complete": "token-forbidden",

  // Food safety records (HACCP). Agents may read, draft plans, raise or fill in corrective
  // actions and record CCP readings (marked `source: api` and held `pending` until a person
  // reviews them). Approving a plan, reviewing readings and closing a corrective action are
  // sign-offs (`manage` and a person); corrections, cleaning, verification and calibration are a
  // person's attestations.
  "GET /v1/workspaces/:slug/haccp/plans": "token-ok",
  "GET /v1/workspaces/:slug/haccp/plans/:id": "token-ok",
  "GET /v1/workspaces/:slug/haccp/plans/:id/versions/:versionId": "token-ok",
  "POST /v1/workspaces/:slug/haccp/plans": "token-ok",
  "PATCH /v1/workspaces/:slug/haccp/plans/:id": "token-ok",
  "POST /v1/workspaces/:slug/haccp/plans/:id/status": "token-forbidden",
  "PUT /v1/workspaces/:slug/haccp/plans/:id/draft": "token-ok",
  "DELETE /v1/workspaces/:slug/haccp/plans/:id/draft": "token-ok",
  "POST /v1/workspaces/:slug/haccp/plans/:id/draft/approve": "token-forbidden",
  "DELETE /v1/workspaces/:slug/haccp/plans/:id": "token-ok",
  "GET /v1/workspaces/:slug/haccp/due": "token-ok",
  "GET /v1/workspaces/:slug/haccp/batches/:batchId": "token-ok",
  "GET /v1/workspaces/:slug/haccp/logs": "token-ok",
  "GET /v1/workspaces/:slug/haccp/logs/:id": "token-ok",
  "POST /v1/workspaces/:slug/haccp/logs": "token-ok",
  "POST /v1/workspaces/:slug/haccp/logs/review": "token-forbidden",
  "POST /v1/workspaces/:slug/haccp/logs/:id/review": "token-forbidden",
  "POST /v1/workspaces/:slug/haccp/logs/:id/correct": "token-forbidden",
  "GET /v1/workspaces/:slug/haccp/deviations": "token-ok",
  "GET /v1/workspaces/:slug/haccp/corrective-actions": "token-ok",
  "GET /v1/workspaces/:slug/haccp/corrective-actions/:id": "token-ok",
  "POST /v1/workspaces/:slug/haccp/corrective-actions": "token-ok",
  "PATCH /v1/workspaces/:slug/haccp/corrective-actions/:id": "token-ok",
  "POST /v1/workspaces/:slug/haccp/corrective-actions/:id/close": "token-forbidden",
  "GET /v1/workspaces/:slug/haccp/assets": "token-ok",
  "PATCH /v1/workspaces/:slug/haccp/assets/:id": "token-ok",
  "GET /v1/workspaces/:slug/haccp/cleaning": "token-ok",
  "POST /v1/workspaces/:slug/haccp/cleaning": "token-forbidden",
  "POST /v1/workspaces/:slug/haccp/cleaning/:id/verify": "token-forbidden",
  "GET /v1/workspaces/:slug/haccp/calibration": "token-ok",
  "POST /v1/workspaces/:slug/haccp/calibration": "token-forbidden",
  "POST /v1/workspaces/:slug/haccp/cleaning/:id/correct": "token-forbidden",
  "POST /v1/workspaces/:slug/haccp/calibration/:id/correct": "token-forbidden",
  "GET /v1/workspaces/:slug/haccp/signoffs": "token-ok",
  "POST /v1/workspaces/:slug/haccp/signoffs": "token-forbidden",
  "POST /v1/workspaces/:slug/haccp/signoffs/bulk": "token-forbidden",
  "POST /v1/workspaces/:slug/haccp/plans/:id/hazard-review": "token-forbidden",
  "GET /v1/workspaces/:slug/haccp/library": "token-ok",
  "GET /v1/workspaces/:slug/haccp/library/:id": "token-ok",
  "POST /v1/workspaces/:slug/haccp/library": "token-ok",
  "PUT /v1/workspaces/:slug/haccp/library/:id": "token-ok",
  "DELETE /v1/workspaces/:slug/haccp/library/:id": "token-ok",
  "GET /v1/workspaces/:slug/haccp/templates": "token-ok",
  "GET /v1/workspaces/:slug/haccp/templates/:id": "token-ok",
  "POST /v1/workspaces/:slug/haccp/templates": "token-ok",
  "PUT /v1/workspaces/:slug/haccp/templates/:id": "token-ok",
  "DELETE /v1/workspaces/:slug/haccp/templates/:id": "token-ok",

  // Demand: workspace data that agents and the sales system post through tokens. No sign-offs.
  "GET /v1/workspaces/:slug/demand/summary": "token-ok",
  "GET /v1/workspaces/:slug/demand/forecast": "token-ok",
  "POST /v1/workspaces/:slug/demand/forecast/apply": "token-ok",
  "GET /v1/workspaces/:slug/demand/coverage": "token-ok",
  "GET /v1/workspaces/:slug/demand/pack-units": "token-ok",
  "PUT /v1/workspaces/:slug/demand/pack-units": "token-ok",
  "DELETE /v1/workspaces/:slug/demand/pack-units/:id": "token-ok",
  "GET /v1/workspaces/:slug/demand/lines": "token-ok",
  "PUT /v1/workspaces/:slug/demand/lines": "token-ok",
  "GET /v1/workspaces/:slug/demand/lines/:id/history": "token-ok",
  "DELETE /v1/workspaces/:slug/demand/lines/:id": "token-ok",
  "GET /v1/workspaces/:slug/demand/imports": "token-ok",
  "POST /v1/workspaces/:slug/demand/imports": "token-ok",
  // People. PINs are a manager's act: an agent can never set, clear or unlock one.
  "GET /v1/workspaces/:slug/people/staff": "token-ok",
  "GET /v1/workspaces/:slug/people/staff-number": "token-ok",
  "GET /v1/workspaces/:slug/people/staff/:id": "token-ok",
  "POST /v1/workspaces/:slug/people/staff": "token-ok",
  "POST /v1/workspaces/:slug/people/staff/import": "token-ok",
  "PATCH /v1/workspaces/:slug/people/staff/:id": "token-ok",
  "DELETE /v1/workspaces/:slug/people/staff/:id": "token-ok",
  "PUT /v1/workspaces/:slug/people/staff/:id/pin": "token-forbidden",
  "DELETE /v1/workspaces/:slug/people/staff/:id/pin": "token-forbidden",
  "POST /v1/workspaces/:slug/people/staff/:id/unlock": "token-forbidden",
  "GET /v1/workspaces/:slug/people/job-roles": "token-ok",
  "POST /v1/workspaces/:slug/people/job-roles": "token-ok",
  "PATCH /v1/workspaces/:slug/people/job-roles/:id": "token-ok",
  "DELETE /v1/workspaces/:slug/people/job-roles/:id": "token-ok",
  // Training. A competency sign-off and voiding a record are a person's acts.
  "GET /v1/workspaces/:slug/training/courses": "token-ok",
  "GET /v1/workspaces/:slug/training/courses/:id": "token-ok",
  "POST /v1/workspaces/:slug/training/courses": "token-ok",
  "PATCH /v1/workspaces/:slug/training/courses/:id": "token-ok",
  "DELETE /v1/workspaces/:slug/training/courses/:id": "token-ok",
  "PUT /v1/workspaces/:slug/training/courses/:id/requirements": "token-ok",
  "POST /v1/workspaces/:slug/training/courses/:id/backfill": "token-ok",
  "GET /v1/workspaces/:slug/training/matrix": "token-ok",
  "GET /v1/workspaces/:slug/training/due": "token-ok",
  "GET /v1/workspaces/:slug/training/staff/:staffId": "token-ok",
  "GET /v1/workspaces/:slug/training/records": "token-ok",
  "POST /v1/workspaces/:slug/training/records": "token-ok",
  "POST /v1/workspaces/:slug/training/records/sign-off": "token-forbidden",
  "POST /v1/workspaces/:slug/training/records/:id/void": "token-forbidden",
  // Quality. Agents may log complaints, raise non-conformances and plan audits; closing,
  // verifying, reopening, completing an audit and recording or voiding a recall test are a person's.
  "GET /v1/workspaces/:slug/quality/summary": "token-ok",
  "GET /v1/workspaces/:slug/quality/complaints": "token-ok",
  "GET /v1/workspaces/:slug/quality/complaints/:id": "token-ok",
  "POST /v1/workspaces/:slug/quality/complaints": "token-ok",
  "PATCH /v1/workspaces/:slug/quality/complaints/:id": "token-ok",
  "POST /v1/workspaces/:slug/quality/complaints/:id/close": "token-forbidden",
  "POST /v1/workspaces/:slug/quality/complaints/:id/reopen": "token-forbidden",
  "GET /v1/workspaces/:slug/quality/nonconformances": "token-ok",
  "GET /v1/workspaces/:slug/quality/nonconformances/:id": "token-ok",
  "POST /v1/workspaces/:slug/quality/nonconformances": "token-ok",
  "PATCH /v1/workspaces/:slug/quality/nonconformances/:id": "token-ok",
  "POST /v1/workspaces/:slug/quality/nonconformances/:id/close": "token-forbidden",
  "POST /v1/workspaces/:slug/quality/nonconformances/:id/reopen": "token-forbidden",
  "GET /v1/workspaces/:slug/quality/audits": "token-ok",
  "GET /v1/workspaces/:slug/quality/audits/:id": "token-ok",
  "POST /v1/workspaces/:slug/quality/audits": "token-ok",
  "PATCH /v1/workspaces/:slug/quality/audits/:id": "token-ok",
  "DELETE /v1/workspaces/:slug/quality/audits/:id": "token-ok",
  "POST /v1/workspaces/:slug/quality/audits/:id/complete": "token-forbidden",
  "POST /v1/workspaces/:slug/quality/audits/:id/cancel": "token-ok",
  "GET /v1/workspaces/:slug/quality/audit-programmes": "token-ok",
  "POST /v1/workspaces/:slug/quality/audit-programmes": "token-ok",
  "PATCH /v1/workspaces/:slug/quality/audit-programmes/:id": "token-ok",
  "DELETE /v1/workspaces/:slug/quality/audit-programmes/:id": "token-ok",
  "GET /v1/workspaces/:slug/quality/trends": "token-ok",
  "GET /v1/workspaces/:slug/quality/sales-volumes": "token-ok",
  "PUT /v1/workspaces/:slug/quality/sales-volumes": "token-ok",
  "GET /v1/workspaces/:slug/quality/suppliers/:id": "token-ok",
  "POST /v1/workspaces/:slug/quality/suppliers/:id/review": "token-forbidden",
  "GET /v1/workspaces/:slug/quality/recall-tests/prefill": "token-ok",
  "GET /v1/workspaces/:slug/quality/recall-tests": "token-ok",
  "GET /v1/workspaces/:slug/quality/recall-tests/:id": "token-ok",
  "POST /v1/workspaces/:slug/quality/recall-tests": "token-forbidden",
  "POST /v1/workspaces/:slug/quality/recall-tests/:id/void": "token-forbidden",
  // Purchasing. Agents may draft and edit orders and record deliveries; sending (a commitment to
  // buy), closing and cancelling are a person's acts (`forbidTokens`).
  "GET /v1/workspaces/:slug/purchasing/orders": "token-ok",
  "GET /v1/workspaces/:slug/purchasing/orders/:id": "token-ok",
  "POST /v1/workspaces/:slug/purchasing/orders": "token-ok",
  "PATCH /v1/workspaces/:slug/purchasing/orders/:id": "token-ok",
  "DELETE /v1/workspaces/:slug/purchasing/orders/:id": "token-ok",
  "POST /v1/workspaces/:slug/purchasing/orders/:id/receipts": "token-ok",
  "POST /v1/workspaces/:slug/purchasing/orders/:id/send": "token-action",
  "POST /v1/workspaces/:slug/purchasing/orders/:id/close": "token-action",
  "POST /v1/workspaces/:slug/purchasing/orders/:id/cancel": "token-action",
  "POST /v1/workspaces/:slug/purchasing/orders/:id/approve": "token-forbidden",
  "POST /v1/workspaces/:slug/purchasing/orders/:id/email": "token-action",
  "POST /v1/workspaces/:slug/purchasing/orders/:id/receipts/:receiptId/void": "token-forbidden",
  "GET /v1/workspaces/:slug/purchasing/settings": "token-ok",
  "PUT /v1/workspaces/:slug/purchasing/settings": "token-forbidden",
  "GET /v1/workspaces/:slug/purchasing/prices": "token-ok",
  "POST /v1/workspaces/:slug/purchasing/prices": "token-ok",
  "PATCH /v1/workspaces/:slug/purchasing/prices/:id": "token-ok",
  "DELETE /v1/workspaces/:slug/purchasing/prices/:id": "token-ok",
  "GET /v1/workspaces/:slug/purchasing/credit-notes": "token-ok",
  "GET /v1/workspaces/:slug/purchasing/credit-notes/:id": "token-ok",
  "POST /v1/workspaces/:slug/purchasing/credit-notes": "token-ok",
  "PATCH /v1/workspaces/:slug/purchasing/credit-notes/:id": "token-ok",
  "DELETE /v1/workspaces/:slug/purchasing/credit-notes/:id": "token-ok",
  "POST /v1/workspaces/:slug/purchasing/credit-notes/:id/approve": "token-forbidden",
  "POST /v1/workspaces/:slug/purchasing/credit-notes/:id/void": "token-forbidden",
  "GET /v1/workspaces/:slug/purchasing/suggestions": "token-ok",
  "POST /v1/workspaces/:slug/purchasing/suggestions": "token-ok",
  "GET /v1/workspaces/:slug/purchasing/supplier-performance": "token-ok",
  // Supplier invoices. Agents may draft and revise invoices; approving one for payment and
  // changing the match tolerances are a person's acts (`forbidTokens`).
  "GET /v1/workspaces/:slug/purchasing/invoice-settings": "token-ok",
  "PUT /v1/workspaces/:slug/purchasing/invoice-settings": "token-forbidden",
  "GET /v1/workspaces/:slug/purchasing/invoices": "token-ok",
  "GET /v1/workspaces/:slug/purchasing/invoices/:id": "token-ok",
  "POST /v1/workspaces/:slug/purchasing/invoices": "token-ok",
  "PATCH /v1/workspaces/:slug/purchasing/invoices/:id": "token-ok",
  "DELETE /v1/workspaces/:slug/purchasing/invoices/:id": "token-ok",
  "POST /v1/workspaces/:slug/purchasing/invoices/:id/revise": "token-ok",
  "POST /v1/workspaces/:slug/purchasing/invoices/:id/approve": "token-forbidden",
  // Costing: reads only (costs are computed on read; nothing to sign off). The module grant
  // (`read` on costing) is what keeps them from people and tokens without it.
  "GET /v1/workspaces/:slug/costing/batches": "token-ok",
  "GET /v1/workspaces/:slug/costing/batches/:id": "token-ok",
  "GET /v1/workspaces/:slug/costing/lots/:id": "token-ok",
  "GET /v1/workspaces/:slug/costing/report": "token-ok",
  "GET /v1/workspaces/:slug/costing/closes": "token-ok",
  "GET /v1/workspaces/:slug/costing/closes/:id": "token-ok",
  "POST /v1/workspaces/:slug/costing/closes": "token-forbidden",
  "POST /v1/workspaces/:slug/costing/closes/:id/reopen": "token-forbidden",
  "GET /v1/workspaces/:slug/costing/valuation": "token-ok",
  "GET /v1/workspaces/:slug/costing/adjustments": "token-ok",
  "GET /v1/workspaces/:slug/costing/export.csv": "token-ok",
  "GET /v1/workspaces/:slug/costing/standard-costs/:itemId": "token-ok",
  "PUT /v1/workspaces/:slug/costing/standard-costs": "token-forbidden",
  "GET /v1/workspaces/:slug/costing/rates": "token-ok",
  "PUT /v1/workspaces/:slug/costing/rates": "token-forbidden",
  // Site programmes. Agents may keep the registers, enter pest control visits, record storage
  // readings (held for review), raise a breakage and raise corrective actions; sign-offs, checks
  // that attest a person did something, and corrections are a person's acts (`forbidTokens`).
  "GET /v1/workspaces/:slug/site/areas": "token-ok",
  "GET /v1/workspaces/:slug/site/due": "token-ok",
  "GET /v1/workspaces/:slug/site/calibration-instruments": "token-ok",
  "GET /v1/workspaces/:slug/site/pest/trends": "token-ok",
  "POST /v1/workspaces/:slug/site/glass/items/import": "token-ok",
  "GET /v1/workspaces/:slug/site/checklists/allergen-risk": "token-ok",
  "GET /v1/workspaces/:slug/site/maintenance/work-orders": "token-ok",
  "GET /v1/workspaces/:slug/maintenance/work-orders": "token-ok",
  "GET /v1/workspaces/:slug/site/maintenance/work-orders/:id": "token-ok",
  "GET /v1/workspaces/:slug/maintenance/work-orders/:id": "token-ok",
  "POST /v1/workspaces/:slug/site/maintenance/work-orders": "token-ok",
  "POST /v1/workspaces/:slug/maintenance/work-orders": "token-ok",
  "PATCH /v1/workspaces/:slug/site/maintenance/work-orders/:id": "token-ok",
  "PATCH /v1/workspaces/:slug/maintenance/work-orders/:id": "token-ok",
  "POST /v1/workspaces/:slug/site/maintenance/work-orders/:id/complete": "token-forbidden",
  "POST /v1/workspaces/:slug/maintenance/work-orders/:id/complete": "token-forbidden",
  "POST /v1/workspaces/:slug/site/maintenance/work-orders/:id/cancel": "token-forbidden",
  "POST /v1/workspaces/:slug/maintenance/work-orders/:id/cancel": "token-forbidden",
  "GET /v1/workspaces/:slug/site/pest/devices": "token-ok",
  "POST /v1/workspaces/:slug/site/pest/devices": "token-ok",
  "PATCH /v1/workspaces/:slug/site/pest/devices/:id": "token-ok",
  "GET /v1/workspaces/:slug/site/pest/visits": "token-ok",
  "GET /v1/workspaces/:slug/site/pest/visits/:id": "token-ok",
  "POST /v1/workspaces/:slug/site/pest/visits": "token-ok",
  "POST /v1/workspaces/:slug/site/pest/visits/:id/correct": "token-forbidden",
  "GET /v1/workspaces/:slug/site/glass/items": "token-ok",
  "POST /v1/workspaces/:slug/site/glass/items": "token-ok",
  "PATCH /v1/workspaces/:slug/site/glass/items/:id": "token-ok",
  "GET /v1/workspaces/:slug/site/glass/checks": "token-ok",
  "GET /v1/workspaces/:slug/site/glass/checks/:id": "token-ok",
  "POST /v1/workspaces/:slug/site/glass/checks": "token-forbidden",
  "POST /v1/workspaces/:slug/site/glass/checks/:id/correct": "token-forbidden",
  "GET /v1/workspaces/:slug/site/glass/breakages": "token-ok",
  "GET /v1/workspaces/:slug/site/glass/breakages/:id": "token-ok",
  "POST /v1/workspaces/:slug/site/glass/breakages": "token-ok",
  "PATCH /v1/workspaces/:slug/site/glass/breakages/:id": "token-ok",
  "POST /v1/workspaces/:slug/site/glass/breakages/:id/release": "token-forbidden",
  "GET /v1/workspaces/:slug/maintenance/areas": "token-ok",
  "GET /v1/workspaces/:slug/site/maintenance/areas": "token-ok",
  "GET /v1/workspaces/:slug/maintenance/calibration-instruments": "token-ok",
  "GET /v1/workspaces/:slug/site/maintenance/calibration-instruments": "token-ok",
  "GET /v1/workspaces/:slug/site/maintenance/assets": "token-ok",
  "GET /v1/workspaces/:slug/maintenance/assets": "token-ok",
  "PATCH /v1/workspaces/:slug/site/maintenance/assets/:id": "token-ok",
  "PATCH /v1/workspaces/:slug/maintenance/assets/:id": "token-ok",
  "GET /v1/workspaces/:slug/site/maintenance/tasks": "token-ok",
  "GET /v1/workspaces/:slug/maintenance/tasks": "token-ok",
  "POST /v1/workspaces/:slug/site/maintenance/tasks": "token-ok",
  "POST /v1/workspaces/:slug/maintenance/tasks": "token-ok",
  "PATCH /v1/workspaces/:slug/site/maintenance/tasks/:id": "token-ok",
  "PATCH /v1/workspaces/:slug/maintenance/tasks/:id": "token-ok",
  "GET /v1/workspaces/:slug/site/maintenance/records": "token-ok",
  "GET /v1/workspaces/:slug/maintenance/records": "token-ok",
  "GET /v1/workspaces/:slug/site/maintenance/records/:id": "token-ok",
  "GET /v1/workspaces/:slug/maintenance/records/:id": "token-ok",
  "POST /v1/workspaces/:slug/site/maintenance/records": "token-forbidden",
  "POST /v1/workspaces/:slug/maintenance/records": "token-forbidden",
  "POST /v1/workspaces/:slug/site/maintenance/records/:id/correct": "token-forbidden",
  "POST /v1/workspaces/:slug/maintenance/records/:id/correct": "token-forbidden",
  "POST /v1/workspaces/:slug/site/maintenance/records/:id/clearance": "token-forbidden",
  "POST /v1/workspaces/:slug/maintenance/records/:id/clearance": "token-forbidden",
  "GET /v1/workspaces/:slug/site/storage/units": "token-ok",
  "POST /v1/workspaces/:slug/site/storage/units": "token-ok",
  "PATCH /v1/workspaces/:slug/site/storage/units/:id": "token-ok",
  "GET /v1/workspaces/:slug/site/storage/readings": "token-ok",
  "GET /v1/workspaces/:slug/site/storage/readings/:id": "token-ok",
  "POST /v1/workspaces/:slug/site/storage/readings": "token-ok",
  "POST /v1/workspaces/:slug/site/storage/readings/review": "token-forbidden",
  "POST /v1/workspaces/:slug/site/storage/readings/:id/review": "token-forbidden",
  "POST /v1/workspaces/:slug/site/storage/readings/:id/correct": "token-forbidden",
  "GET /v1/workspaces/:slug/site/actions": "token-ok",
  "GET /v1/workspaces/:slug/site/actions/:id": "token-ok",
  "POST /v1/workspaces/:slug/site/actions": "token-ok",
  "PATCH /v1/workspaces/:slug/site/actions/:id": "token-ok",
  "POST /v1/workspaces/:slug/site/actions/:id/close": "token-forbidden",
  "GET /v1/workspaces/:slug/site/checklists/templates": "token-ok",
  "GET /v1/workspaces/:slug/site/checklists/templates/:id": "token-ok",
  "POST /v1/workspaces/:slug/site/checklists/templates": "token-ok",
  "PATCH /v1/workspaces/:slug/site/checklists/templates/:id": "token-ok",
  "GET /v1/workspaces/:slug/site/checklists/checks": "token-ok",
  "GET /v1/workspaces/:slug/site/checklists/checks/:id": "token-ok",
  "POST /v1/workspaces/:slug/site/checklists/checks": "token-forbidden",
  "POST /v1/workspaces/:slug/site/checklists/checks/:id/correct": "token-forbidden",
  "POST /v1/workspaces/:slug/site/checklists/checks/:id/sign-off": "token-forbidden",
  // Labels and nutrition. Agents may enter nutrition from specifications and draft labels;
  // approving a label is a sign-off by a person.
  "GET /v1/workspaces/:slug/labelling/items": "token-ok",
  "GET /v1/workspaces/:slug/labelling/items/:itemId": "token-ok",
  "PUT /v1/workspaces/:slug/labelling/items/:itemId": "token-ok",
  "POST /v1/workspaces/:slug/labelling/items/import": "token-ok",
  "GET /v1/workspaces/:slug/labelling/recipes/:id/versions/:versionId": "token-ok",
  "GET /v1/workspaces/:slug/labelling/labels": "token-ok",
  "GET /v1/workspaces/:slug/labelling/labels/:id": "token-ok",
  "POST /v1/workspaces/:slug/labelling/labels": "token-ok",
  "PATCH /v1/workspaces/:slug/labelling/labels/:id": "token-ok",
  "POST /v1/workspaces/:slug/labelling/labels/:id/refresh": "token-ok",
  "POST /v1/workspaces/:slug/labelling/labels/:id/approve": "token-forbidden",
  "DELETE /v1/workspaces/:slug/labelling/labels/:id": "token-ok",
  "GET /v1/workspaces/:slug/specifications": "token-ok",
  "GET /v1/workspaces/:slug/specifications/:id": "token-ok",
  "GET /v1/workspaces/:slug/specifications/:id/versions/:versionId": "token-ok",
  "GET /v1/workspaces/:slug/specifications/:id/impact": "token-ok",
  "POST /v1/workspaces/:slug/specifications": "token-ok",
  "PATCH /v1/workspaces/:slug/specifications/:id": "token-ok",
  "PUT /v1/workspaces/:slug/specifications/:id/draft": "token-ok",
  "DELETE /v1/workspaces/:slug/specifications/:id/draft": "token-ok",
  "POST /v1/workspaces/:slug/specifications/:id/draft/approve": "token-forbidden",
  "DELETE /v1/workspaces/:slug/specifications/:id": "token-ok",
  "GET /v1/workspaces/:slug/testing/laboratories": "token-ok",
  "POST /v1/workspaces/:slug/testing/laboratories": "token-ok",
  "PATCH /v1/workspaces/:slug/testing/laboratories/:id": "token-ok",
  "GET /v1/workspaces/:slug/testing/points": "token-ok",
  "POST /v1/workspaces/:slug/testing/points": "token-ok",
  "PATCH /v1/workspaces/:slug/testing/points/:id": "token-ok",
  "GET /v1/workspaces/:slug/testing/plans": "token-ok",
  "POST /v1/workspaces/:slug/testing/plans": "token-ok",
  "PATCH /v1/workspaces/:slug/testing/plans/:id": "token-ok",
  "GET /v1/workspaces/:slug/testing/samples": "token-ok",
  "GET /v1/workspaces/:slug/testing/samples/:id": "token-ok",
  "POST /v1/workspaces/:slug/testing/samples": "token-ok",
  "POST /v1/workspaces/:slug/testing/samples/:id/results": "token-ok",
  "POST /v1/workspaces/:slug/testing/samples/:id/cancel": "token-ok",
  "POST /v1/workspaces/:slug/testing/samples/:id/investigation/close": "token-forbidden",
  "GET /v1/workspaces/:slug/testing/trends": "token-ok",
  "GET /v1/workspaces/:slug/testing/analytes": "token-ok",
  "GET /v1/workspaces/:slug/npd/projects": "token-ok",
  "GET /v1/workspaces/:slug/npd/projects/:id": "token-ok",
  "POST /v1/workspaces/:slug/npd/projects": "token-ok",
  "PATCH /v1/workspaces/:slug/npd/projects/:id": "token-ok",
  "POST /v1/workspaces/:slug/npd/projects/:id/trials": "token-ok",
  "POST /v1/workspaces/:slug/npd/projects/:id/signoffs": "token-forbidden",
  "POST /v1/workspaces/:slug/npd/projects/:id/launch": "token-forbidden",
  "GET /v1/workspaces/:slug/defence/overview": "token-ok",
  "GET /v1/workspaces/:slug/defence/assessments": "token-ok",
  "GET /v1/workspaces/:slug/defence/assessments/:id": "token-ok",
  "POST /v1/workspaces/:slug/defence/assessments": "token-ok",
  "PATCH /v1/workspaces/:slug/defence/assessments/:id": "token-ok",
  "PUT /v1/workspaces/:slug/defence/assessments/:id/draft": "token-ok",
  "POST /v1/workspaces/:slug/defence/assessments/:id/review": "token-ok",
  "POST /v1/workspaces/:slug/defence/assessments/:id/draft/approve": "token-forbidden",
  "GET /v1/workspaces/:slug/defence/controls": "token-ok",
  "POST /v1/workspaces/:slug/defence/controls": "token-ok",
  "PATCH /v1/workspaces/:slug/defence/controls/:id": "token-ok",
  "POST /v1/workspaces/:slug/defence/controls/:id/checks": "token-forbidden",
  "GET /v1/workspaces/:slug/defence/checks": "token-ok",
  "POST /v1/workspaces/:slug/defence/checks/:id/resolve": "token-forbidden",
  "GET /v1/workspaces/:slug/defence/exercises": "token-ok",
  "POST /v1/workspaces/:slug/defence/exercises": "token-forbidden",
  "GET /v1/workspaces/:slug/governance/overview": "token-ok",
  "GET /v1/workspaces/:slug/governance/objectives": "token-ok",
  "POST /v1/workspaces/:slug/governance/objectives": "token-ok",
  "PATCH /v1/workspaces/:slug/governance/objectives/:id": "token-ok",
  "POST /v1/workspaces/:slug/governance/objectives/:id/progress": "token-ok",
  "GET /v1/workspaces/:slug/governance/culture": "token-ok",
  "POST /v1/workspaces/:slug/governance/culture": "token-ok",
  "PATCH /v1/workspaces/:slug/governance/culture/:id": "token-ok",
  "GET /v1/workspaces/:slug/governance/requirements": "token-ok",
  "POST /v1/workspaces/:slug/governance/requirements": "token-ok",
  "PATCH /v1/workspaces/:slug/governance/requirements/:id": "token-ok",
  "POST /v1/workspaces/:slug/governance/requirements/:id/review": "token-forbidden",
  "GET /v1/workspaces/:slug/governance/concerns": "token-forbidden",
  "PATCH /v1/workspaces/:slug/governance/concerns/:id": "token-forbidden",
  "GET /v1/workspaces/:slug/governance/reviews": "token-ok",
  "POST /v1/workspaces/:slug/governance/reviews": "token-ok",
  "GET /v1/workspaces/:slug/governance/reviews/:id": "token-ok",
  "PATCH /v1/workspaces/:slug/governance/reviews/:id": "token-ok",
  "POST /v1/workspaces/:slug/governance/reviews/:id/sign": "token-forbidden",
  // A confidential concern is a person's own report, whatever their module access.
  "POST /v1/workspaces/:slug/concerns": "token-forbidden",
  "GET /v1/workspaces/:slug/concerns/mine": "token-forbidden",
  // Attendance. Clocking, roll calls, visitor sign-outs, payroll files and kiosk pairing are a
  // person's acts; agents may read shifts and who is on site.
  "GET /v1/workspaces/:slug/attendance/settings": "token-ok",
  "PATCH /v1/workspaces/:slug/attendance/settings": "token-forbidden",
  "GET /v1/workspaces/:slug/attendance/on-site": "token-ok",
  "GET /v1/workspaces/:slug/attendance/roll-calls": "token-ok",
  "GET /v1/workspaces/:slug/attendance/roll-calls/:id": "token-ok",
  "POST /v1/workspaces/:slug/attendance/roll-calls": "token-forbidden",
  "POST /v1/workspaces/:slug/attendance/roll-calls/:id/entries/:entryId": "token-forbidden",
  "POST /v1/workspaces/:slug/attendance/roll-calls/:id/end": "token-forbidden",
  "GET /v1/workspaces/:slug/attendance/me": "token-ok",
  "GET /v1/workspaces/:slug/attendance/shifts": "token-ok",
  "POST /v1/workspaces/:slug/attendance/events": "token-action",
  "POST /v1/workspaces/:slug/attendance/events/:id/void": "token-forbidden",
  "GET /v1/workspaces/:slug/attendance/payroll": "token-ok",
  "GET /v1/workspaces/:slug/attendance/payroll.csv": "token-action",
  "GET /v1/workspaces/:slug/attendance/visits": "token-ok",
  "GET /v1/workspaces/:slug/attendance/visits/:id": "token-ok",
  "POST /v1/workspaces/:slug/attendance/visits/:id/sign-out": "token-action",
  "GET /v1/workspaces/:slug/attendance/devices": "token-ok",
  "POST /v1/workspaces/:slug/attendance/devices": "token-forbidden",
  "POST /v1/workspaces/:slug/attendance/devices/:id/pairing-code": "token-forbidden",
  "DELETE /v1/workspaces/:slug/attendance/devices/:id": "token-forbidden",
  // Kiosk badges are credentials: issued and revoked by a manager in person. Refused offline
  // kiosk events may be read like shifts, but dismissing one (wrong PINs among them, a security
  // record) is a person's act.
  "GET /v1/workspaces/:slug/attendance/badges": "token-ok",
  "POST /v1/workspaces/:slug/attendance/badges": "token-forbidden",
  "DELETE /v1/workspaces/:slug/attendance/badges/:id": "token-forbidden",
  "GET /v1/workspaces/:slug/attendance/kiosk-rejections": "token-ok",
  "POST /v1/workspaces/:slug/attendance/kiosk-rejections/:id/dismiss": "token-forbidden",

  // Recipes module: an agent may read and draft; approving a version is a person's sign-off
  // (`forbidTokens` + `manage`).
  "GET /v1/workspaces/:slug/recipes": "token-ok",
  "GET /v1/workspaces/:slug/boms": "token-ok",
  "GET /v1/workspaces/:slug/recipes/:id": "token-ok",
  "GET /v1/workspaces/:slug/boms/:id": "token-ok",
  "GET /v1/workspaces/:slug/recipes/:id/versions/:versionId": "token-ok",
  "GET /v1/workspaces/:slug/boms/:id/versions/:versionId": "token-ok",
  "POST /v1/workspaces/:slug/recipes": "token-ok",
  "POST /v1/workspaces/:slug/boms": "token-ok",
  "PATCH /v1/workspaces/:slug/recipes/:id": "token-ok",
  "PATCH /v1/workspaces/:slug/boms/:id": "token-ok",
  "PUT /v1/workspaces/:slug/recipes/:id/draft": "token-ok",
  "PUT /v1/workspaces/:slug/boms/:id/draft": "token-ok",
  "DELETE /v1/workspaces/:slug/recipes/:id/draft": "token-ok",
  "DELETE /v1/workspaces/:slug/boms/:id/draft": "token-ok",
  "POST /v1/workspaces/:slug/recipes/:id/draft/approve": "token-forbidden",
  "POST /v1/workspaces/:slug/boms/:id/draft/approve": "token-forbidden",
  "DELETE /v1/workspaces/:slug/recipes/:id": "token-ok",
  "DELETE /v1/workspaces/:slug/boms/:id": "token-ok",
  // SOPs module: an agent may read, draft and submit. Approving a version and acknowledging one are
  // a person's act (`forbidTokens`); the acknowledgement list is a manager's view.
  "GET /v1/workspaces/:slug/sops": "token-ok",
  "GET /v1/workspaces/:slug/sops/:id": "token-ok",
  "GET /v1/workspaces/:slug/sops/outstanding": "token-ok",
  "GET /v1/workspaces/:slug/sops/copies": "token-ok",
  "GET /v1/workspaces/:slug/sops/copies/:copyId": "token-ok",
  "POST /v1/workspaces/:slug/sops/copies/:copyId/close": "token-forbidden",
  "POST /v1/workspaces/:slug/sops/:id/copies": "token-forbidden",
  "GET /v1/workspaces/:slug/sops/:id/targets": "token-ok",
  "PUT /v1/workspaces/:slug/sops/:id/targets": "token-ok",
  "GET /v1/workspaces/:slug/sops/:id/versions/:versionId": "token-ok",
  "POST /v1/workspaces/:slug/sops": "token-ok",
  "PATCH /v1/workspaces/:slug/sops/:id": "token-ok",
  "PUT /v1/workspaces/:slug/sops/:id/draft": "token-ok",
  "POST /v1/workspaces/:slug/sops/:id/submit": "token-ok",
  "DELETE /v1/workspaces/:slug/sops/:id": "token-ok",
  "POST /v1/workspaces/:slug/sops/:id/versions/:versionId/decision": "token-forbidden",
  "POST /v1/workspaces/:slug/sops/:id/acknowledge": "token-forbidden",
  "GET /v1/workspaces/:slug/sops/:id/versions/:versionId/acknowledgements": "token-ok",

  // The signed-in user's own inbox and preferences. Workspace-scoped and derived from workspace
  // activity, so agents (acting as their owner) may use them; scope still applies.
  "GET /v1/workspaces/:slug/notifications": "token-ok",
  "GET /v1/workspaces/:slug/notifications/unread-count": "token-ok",
  "POST /v1/workspaces/:slug/notifications/read-all": "token-ok",
  "POST /v1/workspaces/:slug/notifications/:id/read": "token-ok",
  "GET /v1/workspaces/:slug/notifications/preferences": "token-ok",
  "PUT /v1/workspaces/:slug/notifications/preferences": "token-ok",
  // Runs the due-date sweep for the workspace now: admins, in person (`requireAdmin`).
  "POST /v1/workspaces/:slug/notifications/sweep": "token-forbidden",

  // Meetings: reads are workspace data; writes act through the owner's Google/Microsoft calendar.
  "GET /v1/workspaces/:slug/meetings/:id": "token-ok",
  "POST /v1/workspaces/:slug/meetings": "token-forbidden",
  "PATCH /v1/workspaces/:slug/meetings/:id": "token-forbidden",
  "POST /v1/workspaces/:slug/meetings/:id/cancel": "token-forbidden",
  "POST /v1/workspaces/:slug/meetings/:id/notes": "token-forbidden",
  "POST /v1/workspaces/:slug/meetings/import": "token-forbidden",

  // Admin: teams, workflow states, labels, members, invitations (`requireAdmin` refuses tokens).
  "GET /v1/workspaces/:slug/teams/archived": "token-forbidden",
  "POST /v1/workspaces/:slug/teams": "token-forbidden",
  "PATCH /v1/workspaces/:slug/teams/:id": "token-forbidden",
  "POST /v1/workspaces/:slug/teams/:id/members": "token-forbidden",
  "DELETE /v1/workspaces/:slug/teams/:id/members/:userId": "token-forbidden",
  "POST /v1/workspaces/:slug/teams/:id/states": "token-forbidden",
  "PATCH /v1/workspaces/:slug/states/:id": "token-forbidden",
  "DELETE /v1/workspaces/:slug/states/:id": "token-forbidden",
  "POST /v1/workspaces/:slug/labels": "token-forbidden",
  "PATCH /v1/workspaces/:slug/labels/:id": "token-forbidden",
  "DELETE /v1/workspaces/:slug/labels/:id": "token-forbidden",
  "PATCH /v1/workspaces/:slug/members/:userId": "token-forbidden",
  "PATCH /v1/workspaces/:slug/members/:userId/profile": "token-forbidden",
  "POST /v1/workspaces/:slug/members/:userId/deactivate": "token-forbidden",
  "POST /v1/workspaces/:slug/members/:userId/reactivate": "token-forbidden",
  "POST /v1/workspaces/:slug/members/:userId/password-reset": "token-forbidden",
  // API access toggles: anyone may read which actions are on (the MCP server picks its tools by
  // it); switching one and reading the audit are owner/admin acts from a real session.
  "GET /v1/workspaces/:slug/token-actions": "token-ok",
  "PUT /v1/workspaces/:slug/token-actions/:action": "token-forbidden",
  "GET /v1/workspaces/:slug/token-actions/log": "token-forbidden",
  // Module access administration (`requireAdmin`).
  "GET /v1/workspaces/:slug/members/module-access": "token-forbidden",
  "PUT /v1/workspaces/:slug/members/:userId/module-access/:moduleId": "token-forbidden",
  "GET /v1/workspaces/:slug/invitations": "token-forbidden",
  "POST /v1/workspaces/:slug/invitations": "token-forbidden",
  "DELETE /v1/workspaces/:slug/invitations/:id": "token-forbidden",
};

/**
 * Module routes guarded by `personOrToken("<action>")`: refused to tokens unless the workspace has
 * switched the action on (`@knotworking/core` token-actions.ts). Classified "token-action" above.
 */
const TOKEN_ACTION_ROUTES: Record<string, TokenActionId> = {
  "POST /v1/workspaces/:slug/stock/waste": "stock.waste",
  "POST /v1/workspaces/:slug/stock/adjustments": "stock.adjust",
  "POST /v1/workspaces/:slug/stock/stocktakes": "stock.stocktake",
  "POST /v1/workspaces/:slug/production/batches/:id/cancel": "production.cancel",
  "POST /v1/workspaces/:slug/purchasing/orders/:id/send": "purchasing.send",
  "POST /v1/workspaces/:slug/purchasing/orders/:id/email": "purchasing.send",
  "POST /v1/workspaces/:slug/purchasing/orders/:id/close": "purchasing.close",
  "POST /v1/workspaces/:slug/purchasing/orders/:id/cancel": "purchasing.cancel",
  "POST /v1/workspaces/:slug/attendance/events": "attendance.events",
  "GET /v1/workspaces/:slug/attendance/payroll.csv": "attendance.payroll_export",
  "POST /v1/workspaces/:slug/bi/dashboards/:id/publish": "bi.publish",
  "POST /v1/workspaces/:slug/bi/dashboards/:id/unpublish": "bi.publish",
  "POST /v1/workspaces/:slug/bi/dashboards/:id/snapshots": "bi.board_packs",
  "POST /v1/workspaces/:slug/bi/packs": "bi.board_packs",
  "PATCH /v1/workspaces/:slug/bi/packs/:id": "bi.board_packs",
  "POST /v1/workspaces/:slug/bi/packs/:id/issue": "bi.board_packs",
  "DELETE /v1/workspaces/:slug/bi/packs/:id": "bi.board_packs",
  "POST /v1/workspaces/:slug/attendance/visits/:id/sign-out": "attendance.visit_sign_out",
};

/**
 * Module routes guarded by `forbidTokens`: always a person, never toggleable. Each names its entry
 * in `personOnlyActions` (core token-actions.ts) by label, so the settings page can say why. A new
 * `forbidTokens` route fails the accounting test until it is listed here or made a token action.
 */
const PERSON_ONLY_ROUTES: Record<string, string> = {
  "POST /v1/workspaces/:slug/checklists/checks": "Record completed checklists",
  "POST /v1/workspaces/:slug/checklists/checks/:id/correct": "Correct checklist results",
  "POST /v1/workspaces/:slug/checklists/actions/:id/resolve": "Resolve checklist follow-ups",
  "POST /v1/workspaces/:slug/purchase-requests/:id/decision": "Decide or withdraw purchase requests",
  "POST /v1/workspaces/:slug/invoicing/:id/decision": "Approve or discard customer invoices and credit notes",
  "PUT /v1/workspaces/:slug/invoicing/settings":
    "Change invoicing settings: the seller tax registration number and second-approver rule",
  "POST /v1/workspaces/:slug/client-services/:id/decision":
    "Sign client service quote and delivery decisions",
  "POST /v1/workspaces/:slug/crm/opportunities/:id/handoff":
    "Hand off won opportunities to an order or delivery project",
  "GET /v1/workspaces/:slug/workforce/me": "Manage personal leave and sickness requests",
  "POST /v1/workspaces/:slug/workforce/me/absences": "Manage personal leave and sickness requests",
  "POST /v1/workspaces/:slug/workforce/me/absences/:id/withdraw":
    "Manage personal leave and sickness requests",
  "GET /v1/workspaces/:slug/workforce/hr/absences": "Access private HR absence records",
  "POST /v1/workspaces/:slug/workforce/hr/absences": "Access private HR absence records",
  "GET /v1/workspaces/:slug/workforce/hr/absences/:id/history": "Access private HR absence records",
  "POST /v1/workspaces/:slug/workforce/hr/absences/:id/decision": "Access private HR absence records",
  "POST /v1/workspaces/:slug/workforce/hr/absences/:id/correct": "Access private HR absence records",
  "GET /v1/workspaces/:slug/workforce/hr/staff": "Access private HR absence records",
  "GET /v1/workspaces/:slug/workforce/hr/payroll-runs": "Prepare, approve and export payroll runs",
  "GET /v1/workspaces/:slug/workforce/hr/payroll-runs/preview": "Prepare, approve and export payroll runs",
  "POST /v1/workspaces/:slug/workforce/hr/payroll-runs": "Prepare, approve and export payroll runs",
  "GET /v1/workspaces/:slug/workforce/hr/payroll-runs/:id": "Prepare, approve and export payroll runs",
  "POST /v1/workspaces/:slug/workforce/hr/payroll-runs/:id/approve":
    "Prepare, approve and export payroll runs",
  "POST /v1/workspaces/:slug/workforce/hr/payroll-runs/:id/correct":
    "Prepare, approve and export payroll runs",
  "POST /v1/workspaces/:slug/workforce/hr/payroll-runs/:id/export":
    "Prepare, approve and export payroll runs",
  "POST /v1/workspaces/:slug/workforce/hr/payroll-runs/:id/withdraw":
    "Prepare, approve and export payroll runs",
  "POST /v1/workspaces/:slug/hse/registers/:id/approve": "Approve HSE registers",
  "POST /v1/workspaces/:slug/hse/registers/:id/archive": "Archive HSE registers",
  "POST /v1/workspaces/:slug/hse/registers/:id/entries": "Record HSE verifications",
  "POST /v1/workspaces/:slug/hse/registers/:id/entries/:entryId/void": "Correct HSE verification records",
  "POST /v1/workspaces/:slug/hse/permits/:id/issue": "Issue HSE permits",
  "POST /v1/workspaces/:slug/hse/permits/:id/suspend": "Suspend HSE permits",
  "POST /v1/workspaces/:slug/hse/permits/:id/resume": "Resume HSE permits",
  "POST /v1/workspaces/:slug/hse/permits/:id/close": "Close HSE permits",
  "POST /v1/workspaces/:slug/hse/permits/:id/cancel": "Cancel HSE permits",
  "GET /v1/workspaces/:slug/hse/incidents": "Access restricted HSE incidents",
  "POST /v1/workspaces/:slug/hse/incidents": "Access restricted HSE incidents",
  "GET /v1/workspaces/:slug/hse/incidents/:id": "Access restricted HSE incidents",
  "PUT /v1/workspaces/:slug/hse/incidents/:id": "Access restricted HSE incidents",
  "GET /v1/workspaces/:slug/hse/incidents/:id/history": "Access restricted HSE incidents",
  "POST /v1/workspaces/:slug/hse/incidents/:id/close": "Access restricted HSE incidents",
  "GET /v1/workspaces/:slug/hse/incidents/overview": "Access restricted HSE incidents",
  "POST /v1/workspaces/:slug/hse/incidents/:id/actions": "Access restricted HSE incidents",
  "POST /v1/workspaces/:slug/hse/incidents/:id/actions/:actionId/complete": "Access restricted HSE incidents",
  "PUT /v1/workspaces/:slug/hse/incidents/:id/injuries": "Access restricted HSE incidents",

  "POST /v1/workspaces/:slug/sales/orders/:id/amend": "Amend confirmed sales orders",
  "POST /v1/workspaces/:slug/sales/orders/:id/confirm": "Confirm sales orders",
  "POST /v1/workspaces/:slug/sales/orders/:id/issue": "Issue sales quotes",
  "POST /v1/workspaces/:slug/sales/orders/:id/cancel": "Cancel sales documents",
  "POST /v1/workspaces/:slug/sales/orders/:id/convert": "Convert sales quotes",
  "POST /v1/workspaces/:slug/sales/orders/:id/fulfilments": "Link sales deliveries",
  "POST /v1/workspaces/:slug/sales/orders/:id/fulfilments/:linkId/void": "Correct sales delivery links",
  "POST /v1/workspaces/:slug/sales/prices": "Agree sales prices",
  "POST /v1/workspaces/:slug/sales/prices/:id/archive": "Archive sales prices",

  "POST /v1/workspaces/:slug/quality/authenticity/:id/approve": "Approve authenticity assessments",
  "POST /v1/workspaces/:slug/quality/authenticity/:id/versions/:versionId/controls/:controlId/verify":
    "Verify authenticity controls",
  "POST /v1/workspaces/:slug/quality/authenticity/:id/verifications/:verificationId/void":
    "Correct authenticity verification records",
  "POST /v1/workspaces/:slug/quality/authenticity/:id/archive": "Archive authenticity assessments",

  "POST /v1/workspaces/:slug/despatch/:id/allocate": "Allocate despatch stock",
  "POST /v1/workspaces/:slug/despatch/:id/unallocate": "Release despatch allocations",
  "POST /v1/workspaces/:slug/despatch/:id/pack": "Sign despatch packing",
  "POST /v1/workspaces/:slug/despatch/:id/load-check": "Sign despatch load checks",
  "POST /v1/workspaces/:slug/despatch/:id/proof": "Record delivery proof",
  "POST /v1/workspaces/:slug/despatch/:id/returns": "Receive customer returns",
  "POST /v1/workspaces/:slug/despatch/:id/returns/:returnId/void": "Void customer return receipts",

  "POST /v1/workspaces/:slug/quality/incidents/:id/contain": "Contain incident stock",
  "POST /v1/workspaces/:slug/quality/incidents/:id/events": "Record incident evidence",
  "POST /v1/workspaces/:slug/quality/incidents/:id/release": "Release incident holds",
  "POST /v1/workspaces/:slug/quality/incidents/:id/close": "Close incident cases",

  "POST /v1/workspaces/:slug/despatch/:id/confirm": "Confirm despatches",
  "POST /v1/workspaces/:slug/despatch/:id/void": "Void despatches",
  "POST /v1/workspaces/:slug/suppliers/:id/approval": "Approve or suspend suppliers",
  "POST /v1/workspaces/:slug/suppliers/:id/risk-assessments": "Assess supplier risk",
  "POST /v1/workspaces/:slug/suppliers/:id/questionnaires/:questionnaireId/review":
    "Accept or reject supplier questionnaires",
  "POST /v1/workspaces/:slug/recipes/:id/draft/approve": "Approve recipe versions",
  "POST /v1/workspaces/:slug/boms/:id/draft/approve": "Approve recipe versions",
  "POST /v1/workspaces/:slug/sops/:id/versions/:versionId/decision": "Approve or reject SOP versions",
  "POST /v1/workspaces/:slug/sops/:id/acknowledge": "Acknowledge SOPs",
  "POST /v1/workspaces/:slug/sops/:id/copies": "Issue and call in controlled SOP copies",
  "POST /v1/workspaces/:slug/sops/copies/:copyId/close": "Issue and call in controlled SOP copies",
  "PUT /v1/workspaces/:slug/suppliers/control-settings": "Change supplier control enforcement",
  "POST /v1/workspaces/:slug/stock/lots/:id/status": "Release, quarantine or reject lots",
  "POST /v1/workspaces/:slug/stock/lots/:id/release-exceptions": "Release, quarantine or reject lots",
  "POST /v1/workspaces/:slug/stock/lots/:id/release-exceptions/:requestId/approve":
    "Release, quarantine or reject lots",
  "POST /v1/workspaces/:slug/stock/lots/:id/release-exceptions/:requestId/reject":
    "Release, quarantine or reject lots",
  "PUT /v1/workspaces/:slug/stock/release-rules/:itemId": "Change lot release rules",
  "DELETE /v1/workspaces/:slug/stock/release-rules/:itemId": "Change lot release rules",
  "POST /v1/workspaces/:slug/stock/movements/:id/reverse": "Reverse stock movements",
  "POST /v1/workspaces/:slug/production/batches/:id/records/:recordId/reverse": "Reverse production records",
  "POST /v1/workspaces/:slug/production/downtime/:id/void": "Void downtime, reject and labour records",
  "POST /v1/workspaces/:slug/production/rejects/:id/void": "Void downtime, reject and labour records",
  "POST /v1/workspaces/:slug/production/labour/:id/void": "Void downtime, reject and labour records",
  "POST /v1/workspaces/:slug/production/packing/:id/close": "Close packing runs",
  "POST /v1/workspaces/:slug/production/packing/checks/:id/void": "Void packing checks",
  "POST /v1/workspaces/:slug/governance/clauses/:id/assessments": "Assess compliance against a standard",
  "POST /v1/workspaces/:slug/governance/drafts/:id/accept": "Assess compliance against a standard",
  "POST /v1/workspaces/:slug/production/batches/:id/complete": "Complete batches",
  "POST /v1/workspaces/:slug/routings/:id/draft/approve": "Approve routing versions",
  "POST /v1/workspaces/:slug/routings/job-cards/:id/exceptions/:exceptionId/resolve":
    "Resolve job card exceptions",
  "POST /v1/workspaces/:slug/routings/job-cards/:id/time/:logId/void":
    "Void job card time and quantity records",
  "POST /v1/workspaces/:slug/routings/job-cards/:id/quantities/:entryId/void":
    "Void job card time and quantity records",
  "POST /v1/workspaces/:slug/haccp/plans/:id/status": "Change a HACCP plan's status",
  "POST /v1/workspaces/:slug/haccp/plans/:id/draft/approve": "Approve HACCP plans",
  "POST /v1/workspaces/:slug/haccp/logs/review": "Review CCP logs",
  "POST /v1/workspaces/:slug/haccp/logs/:id/review": "Review CCP logs",
  "POST /v1/workspaces/:slug/haccp/logs/:id/correct": "Correct CCP log entries",
  "POST /v1/workspaces/:slug/haccp/corrective-actions/:id/close": "Close corrective actions",
  "POST /v1/workspaces/:slug/haccp/cleaning": "Record cleaning",
  "POST /v1/workspaces/:slug/haccp/cleaning/:id/verify": "Verify cleaning",
  "POST /v1/workspaces/:slug/haccp/calibration": "Record calibration",
  "POST /v1/workspaces/:slug/haccp/cleaning/:id/correct": "Correct cleaning records",
  "POST /v1/workspaces/:slug/haccp/calibration/:id/correct": "Correct calibration records",
  "POST /v1/workspaces/:slug/haccp/signoffs": "Sign off a day's CCP monitoring",
  "POST /v1/workspaces/:slug/haccp/signoffs/bulk": "Sign off several plans' CCP monitoring at once",
  "POST /v1/workspaces/:slug/haccp/plans/:id/hazard-review": "Review a plan's hazard analysis",
  "PUT /v1/workspaces/:slug/people/staff/:id/pin": "Set or clear staff PINs and unlock them",
  "DELETE /v1/workspaces/:slug/people/staff/:id/pin": "Set or clear staff PINs and unlock them",
  "POST /v1/workspaces/:slug/people/staff/:id/unlock": "Set or clear staff PINs and unlock them",
  "POST /v1/workspaces/:slug/training/records/sign-off": "Sign off training",
  "POST /v1/workspaces/:slug/training/records/:id/void": "Void training records",
  "POST /v1/workspaces/:slug/quality/complaints/:id/close": "Close or reopen complaints",
  "POST /v1/workspaces/:slug/quality/complaints/:id/reopen": "Close or reopen complaints",
  "POST /v1/workspaces/:slug/quality/nonconformances/:id/close": "Close or reopen non-conformances",
  "POST /v1/workspaces/:slug/quality/nonconformances/:id/reopen": "Close or reopen non-conformances",
  "POST /v1/workspaces/:slug/quality/audits/:id/complete": "Complete audits",
  "POST /v1/workspaces/:slug/quality/suppliers/:id/review": "Record supplier reviews of non-conformances",
  "POST /v1/workspaces/:slug/quality/recall-tests": "Record recall tests",
  "POST /v1/workspaces/:slug/quality/recall-tests/:id/void": "Void recall tests",
  "POST /v1/workspaces/:slug/labelling/labels/:id/approve": "Approve product labels",
  "POST /v1/workspaces/:slug/specifications/:id/draft/approve": "Approve specifications",
  "POST /v1/workspaces/:slug/testing/samples/:id/investigation/close": "Close test investigations",
  "POST /v1/workspaces/:slug/npd/projects/:id/signoffs": "Record product development sign-offs",
  "POST /v1/workspaces/:slug/npd/projects/:id/launch": "Launch new products",
  "POST /v1/workspaces/:slug/defence/assessments/:id/draft/approve": "Approve food defence assessments",
  "POST /v1/workspaces/:slug/defence/controls/:id/checks": "Record security checks",
  "POST /v1/workspaces/:slug/defence/checks/:id/resolve": "Resolve failed security checks",
  "POST /v1/workspaces/:slug/defence/exercises": "Record food defence exercises",
  "POST /v1/workspaces/:slug/governance/requirements/:id/review": "Record compliance reviews",
  "GET /v1/workspaces/:slug/governance/concerns": "Read and handle confidential concerns",
  "PATCH /v1/workspaces/:slug/governance/concerns/:id": "Read and handle confidential concerns",
  "POST /v1/workspaces/:slug/governance/reviews/:id/sign": "Sign management reviews",
  "POST /v1/workspaces/:slug/purchasing/invoices/:id/approve": "Approve supplier invoices for payment",
  "PUT /v1/workspaces/:slug/purchasing/invoice-settings": "Change invoice match tolerances",
  "POST /v1/workspaces/:slug/purchasing/orders/:id/approve": "Approve purchase orders for sending",
  "POST /v1/workspaces/:slug/purchasing/orders/:id/receipts/:receiptId/void":
    "Void refused deliveries and non-stock receipts",
  "PUT /v1/workspaces/:slug/purchasing/settings": "Change purchase order approval and over-delivery settings",
  "POST /v1/workspaces/:slug/purchasing/credit-notes/:id/approve": "Approve supplier credit notes",
  "POST /v1/workspaces/:slug/purchasing/credit-notes/:id/void": "Void supplier credit notes",
  "POST /v1/workspaces/:slug/costing/closes": "Close or reopen costing periods",
  "POST /v1/workspaces/:slug/costing/closes/:id/reopen": "Close or reopen costing periods",
  "PUT /v1/workspaces/:slug/costing/standard-costs": "Change standard costs and absorption rates",
  "PUT /v1/workspaces/:slug/costing/rates": "Change standard costs and absorption rates",
  "PATCH /v1/workspaces/:slug/attendance/settings": "Change attendance settings",
  "POST /v1/workspaces/:slug/attendance/roll-calls": "Run roll calls",
  "POST /v1/workspaces/:slug/attendance/roll-calls/:id/entries/:entryId": "Run roll calls",
  "POST /v1/workspaces/:slug/attendance/roll-calls/:id/end": "Run roll calls",
  "POST /v1/workspaces/:slug/attendance/events/:id/void": "Void clock events",
  "POST /v1/workspaces/:slug/attendance/devices": "Manage kiosk devices and pairing codes",
  "POST /v1/workspaces/:slug/attendance/devices/:id/pairing-code": "Manage kiosk devices and pairing codes",
  "DELETE /v1/workspaces/:slug/attendance/devices/:id": "Manage kiosk devices and pairing codes",
  "POST /v1/workspaces/:slug/attendance/badges": "Issue or revoke kiosk badges",
  "DELETE /v1/workspaces/:slug/attendance/badges/:id": "Issue or revoke kiosk badges",
  "POST /v1/workspaces/:slug/attendance/kiosk-rejections/:id/dismiss": "Dismiss refused kiosk events",
  "POST /v1/workspaces/:slug/site/pest/visits/:id/correct": "Correct site records",
  "POST /v1/workspaces/:slug/site/glass/checks": "Record glass and brittle plastics checks",
  "POST /v1/workspaces/:slug/site/glass/checks/:id/correct": "Correct site records",
  "POST /v1/workspaces/:slug/site/glass/breakages/:id/release": "Release an area after a glass breakage",
  "POST /v1/workspaces/:slug/site/maintenance/records": "Record completed maintenance",
  "POST /v1/workspaces/:slug/maintenance/records": "Record completed maintenance",
  "POST /v1/workspaces/:slug/site/maintenance/work-orders/:id/complete": "Complete work orders",
  "POST /v1/workspaces/:slug/maintenance/work-orders/:id/complete": "Complete work orders",
  "POST /v1/workspaces/:slug/site/maintenance/work-orders/:id/cancel": "Cancel work orders",
  "POST /v1/workspaces/:slug/maintenance/work-orders/:id/cancel": "Cancel work orders",
  "POST /v1/workspaces/:slug/site/maintenance/records/:id/correct": "Correct maintenance records",
  "POST /v1/workspaces/:slug/maintenance/records/:id/correct": "Correct maintenance records",
  "POST /v1/workspaces/:slug/site/maintenance/records/:id/clearance": "Give return-to-service clearance",
  "POST /v1/workspaces/:slug/maintenance/records/:id/clearance": "Give return-to-service clearance",
  "POST /v1/workspaces/:slug/site/storage/readings/review": "Review storage temperature readings",
  "POST /v1/workspaces/:slug/site/storage/readings/:id/review": "Review storage temperature readings",
  "POST /v1/workspaces/:slug/site/storage/readings/:id/correct": "Correct site records",
  "POST /v1/workspaces/:slug/site/actions/:id/close": "Close site corrective actions",
  "POST /v1/workspaces/:slug/site/checklists/checks": "Record pre-start and changeover checks",
  "POST /v1/workspaces/:slug/site/checklists/checks/:id/correct": "Correct site records",
  "POST /v1/workspaces/:slug/site/checklists/checks/:id/sign-off": "Sign off pre-start and changeover checks",
};

/**
 * Path-scoped middleware mounted with `app.use` on an exact (non-wildcard) path. They show up in
 * `app.routes` with method ALL. A path listed here is a guard, not a route; if you mount a real
 * handler with `app.all`/`app.on`, classify it in ROUTES instead.
 */
const KNOWN_PATH_MIDDLEWARE = new Set([
  "/v1/workspaces/:slug/quality/incidents",
  // Quality's item- and stock-centric parts need those soft dependencies readable.
  "/v1/workspaces/:slug/quality/recall-tests",
  "/v1/workspaces/:slug/quality/trends",
  "/v1/workspaces/:slug/quality/sales-volumes",
  "/v1/workspaces/:slug/quality/authenticity",
  "/v1/workspaces/:slug/calendar",
  "/v1/workspaces/:slug/meetings/import",
]);

const ID = "00000000-0000-7000-8000-000000000000";
const concrete = (path: string) =>
  path
    .replace(":slug", "acme")
    .replace(/:(id|userId|revisionId|jobId)\b/g, ID)
    .replace(":moduleId", "tasks")
    .replace(":action", "purchasing.send")
    .replace(":token", "not-a-real-token")
    .replace("/*", "/anything");

const inScope = (path: string) => path.startsWith("/v1/") || path === "/v1" || path.startsWith("/api/");

describe("route classification for personal API tokens", () => {
  let ctx: TestCtx;
  let writeToken: string;
  let readToken: string;
  let ada: string;
  let registered: string[];

  const call = (method: string, path: string, headers: Record<string, string>) =>
    ctx.req(concrete(path), {
      method,
      headers,
      ...(method === "GET" ? {} : { json: {} }),
    });
  const bearer = (token: string) => ({ authorization: `Bearer ${token}`, origin: "" });
  const entries = (kind: Classification) =>
    Object.entries(ROUTES)
      .filter(([, c]) => c === kind)
      .map(([key]) => key.split(" ") as [string, string]);
  /** Drains/cancels so a streaming response (SSE) doesn't keep the test process busy. */
  const discard = async (res: { body: ReadableStream | null }) => void (await res.body?.cancel());

  beforeAll(async () => {
    // No per-token budgets: this file calls every route several times with the same tokens.
    ctx = await makeApp({ seed: true, apiTokenRateLimit: { reads: 0, writes: 0 } });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    const mint = async (scope: "read" | "write") => {
      const res = await ctx.req("/v1/me/api-tokens", {
        method: "POST",
        cookie: ada,
        // Every token action: the allowlist (empty by default) isn't what these tests are about.
        json: { name: scope, scope, tokenActions: [...tokenActionIds] },
      });
      return ((await res.json()) as { token: string }).token;
    };
    writeToken = await mint("write");
    readToken = await mint("read");
    registered = [
      ...new Set(
        ctx.app.routes
          .filter((r) => r.method !== "ALL" && inScope(r.path))
          .map((r) => `${r.method} ${r.path}`),
      ),
    ];
  }, 60_000);
  afterAll(() => ctx.handle.close());

  it("classifies every registered /v1 and /api route", () => {
    const unclassified = registered.filter((key) => !(key in ROUTES));
    expect(
      unclassified,
      `New route(s) registered but not classified in ROUTES (route-classification.test.ts):\n  ${unclassified.join("\n  ")}\n` +
        `Add each as "token-ok", "token-forbidden" (and guard it with forbidTokens/requireAdmin/requireSessionCredential) or "public".`,
    ).toEqual([]);
  });

  it("has no classification for routes that no longer exist", () => {
    const stale = Object.keys(ROUTES).filter((key) => !registered.includes(key));
    expect(
      stale,
      `Classified but no longer registered; remove from ROUTES:\n  ${stale.join("\n  ")}`,
    ).toEqual([]);
  });

  it("knows every exact-path middleware, so a real handler can't hide as one", () => {
    const mounted = new Set(
      ctx.app.routes
        .filter((r) => r.method === "ALL" && inScope(r.path) && !r.path.endsWith("*"))
        .map((r) => r.path),
    );
    const unknown = [...mounted].filter((p) => !KNOWN_PATH_MIDDLEWARE.has(p));
    expect(
      unknown,
      `Unknown app.use/app.all mount(s): ${unknown.join(", ")}. Middleware: add to KNOWN_PATH_MIDDLEWARE. Handler: classify it in ROUTES.`,
    ).toEqual([]);
    const gone = [...KNOWN_PATH_MIDDLEWARE].filter((p) => !mounted.has(p));
    expect(gone, `KNOWN_PATH_MIDDLEWARE lists mounts that no longer exist: ${gone.join(", ")}`).toEqual([]);
  });

  it("refuses every token-forbidden route for a write token", async () => {
    const forbidden = entries("token-forbidden");
    expect(forbidden.length).toBeGreaterThan(0);
    for (const [method, path] of forbidden) {
      const res = await call(method!, path!, bearer(writeToken));
      const body = await res.json();
      expect(res.status, `${method} ${path} must refuse a write token`).toBe(403);
      expect(
        ["token_not_allowed", "session_required"],
        `${method} ${path}: ${JSON.stringify(body)}`,
      ).toContain(body.error?.code);
    }
  }, 60_000);

  it("refuses token-forbidden GETs for a read token too", async () => {
    for (const [method, path] of entries("token-forbidden").filter(([m]) => m === "GET")) {
      const res = await call(method!, path!, bearer(readToken));
      const body = await res.json();
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(["token_not_allowed", "session_required"], `${method} ${path}`).toContain(body.error?.code);
    }
  });

  it("does not refuse token-ok routes on token grounds for a write token", async () => {
    for (const [method, path] of entries("token-ok")) {
      const res = await call(method!, path!, bearer(writeToken));
      if (res.headers.get("content-type")?.includes("event-stream")) await discard(res);
      else if (res.status === 403 || res.status === 401) {
        const code = (await res.json()).error?.code;
        expect(
          ["token_not_allowed", "session_required", "token_read_only", "unauthenticated"],
          `${method} ${path} is token-ok but a write token was refused`,
        ).not.toContain(code);
      }
    }
  }, 60_000); // hundreds of routes: slow on a busy machine

  it("limits a read token on token-ok routes to safe methods", async () => {
    for (const [method, path] of entries("token-ok")) {
      const res = await call(method!, path!, bearer(readToken));
      if (method === "GET") {
        if (res.headers.get("content-type")?.includes("event-stream")) {
          await discard(res);
          continue;
        }
        if (res.status === 403 || res.status === 401) {
          expect(["token_not_allowed", "session_required", "token_read_only"]).not.toContain(
            (await res.json()).error?.code,
          );
        }
      } else {
        expect(res.status, `${method} ${path}`).toBe(403);
        expect((await res.json()).error.code).toBe("token_read_only");
      }
    }
  }, 60_000);

  it("refuses token-action routes to tokens until the workspace switches the action on", async () => {
    const toggled = entries("token-action");
    expect(toggled.length).toBe(Object.keys(TOKEN_ACTION_ROUTES).length);
    const refusedFor = async (token: string, method: string, path: string, action: TokenActionId) => {
      const res = await call(method, path, bearer(token));
      const body = await res.json();
      expect(res.status, `${method} ${path} must refuse a token by default`).toBe(403);
      expect(body.error.code, `${method} ${path}`).toBe("token_not_allowed");
      expect(body.error.details, `${method} ${path}`).toEqual({ action });
      expect(body.error.message).toContain("Settings → API access");
    };
    for (const [method, path] of toggled) {
      const action = TOKEN_ACTION_ROUTES[`${method} ${path}`]!;
      await refusedFor(writeToken, method!, path!, action);
      if (method === "GET") await refusedFor(readToken, method, path!, action);
    }

    const toggle = (action: string, enabled: boolean) =>
      ctx.req(`/v1/workspaces/acme/token-actions/${action}`, {
        method: "PUT",
        cookie: ada,
        json: { enabled },
      });
    for (const action of tokenActionIds) expect((await toggle(action, true)).status).toBe(200);
    try {
      for (const [method, path] of toggled) {
        const res = await call(method!, path!, bearer(writeToken));
        if (res.status === 403 || res.status === 401) {
          const code = (await res.json()).error?.code;
          expect(
            ["token_not_allowed", "session_required", "token_read_only", "unauthenticated"],
            `${method} ${path}: a write token was refused although its action is on`,
          ).not.toContain(code);
        }
      }
    } finally {
      for (const action of tokenActionIds) expect((await toggle(action, false)).status).toBe(200);
    }
  });

  it("accounts for every route that refuses tokens: a toggleable action or always a person", () => {
    const handlers = new Map<string, unknown[]>();
    for (const r of ctx.app.routes) {
      if (r.method === "ALL" || !inScope(r.path)) continue;
      const key = `${r.method} ${r.path}`;
      handlers.set(key, [...(handlers.get(key) ?? []), r.handler]);
    }
    const moduleOf = (key: string) => moduleOfRoute(workspaceSubPath(key.split(" ")[1]!) ?? "");

    const usedActions = new Set<TokenActionId>();
    const usedLabels = new Set<string>();
    for (const [key, chain] of handlers) {
      const action = chain.map(tokenActionOfHandler).find(Boolean);
      if (action) {
        usedActions.add(action);
        expect(TOKEN_ACTION_ROUTES[key], `${key} uses personOrToken("${action}")`).toBe(action);
        expect(ROUTES[key], key).toBe("token-action");
        expect(moduleOf(key), `${key}: ${action} belongs to another module`).toBe(
          tokenActions[action].module,
        );
      }
      if (chain.includes(forbidTokens) && moduleOf(key) !== "platform") {
        const label = PERSON_ONLY_ROUTES[key];
        expect(
          label,
          `${key} uses forbidTokens but is accounted for nowhere. Make it a token action (core ` +
            `token-actions.ts + personOrToken) or add it to PERSON_ONLY_ROUTES and personOnlyActions.`,
        ).toBeDefined();
        expect(action, `${key} has both forbidTokens and personOrToken`).toBeUndefined();
        expect(ROUTES[key], key).toBe("token-forbidden");
        const entry = personOnlyActions.find((a) => a.label === label);
        expect(entry, `"${label}" is not in personOnlyActions`).toBeDefined();
        expect(entry!.module, key).toBe(moduleOf(key));
        usedLabels.add(label!);
      }
    }
    for (const [key, action] of Object.entries(TOKEN_ACTION_ROUTES)) {
      expect(
        handlers.get(key)?.map(tokenActionOfHandler),
        `${key} must use personOrToken("${action}")`,
      ).toContain(action);
    }
    for (const key of Object.keys(PERSON_ONLY_ROUTES)) {
      expect(handlers.get(key), `${key} must use forbidTokens`).toContain(forbidTokens);
    }
    expect(
      tokenActionIds.filter((id) => !usedActions.has(id)),
      "token actions no route uses",
    ).toEqual([]);
    expect(
      personOnlyActions.map((a) => a.label).filter((label) => !usedLabels.has(label)),
      "personOnlyActions no forbidTokens route uses",
    ).toEqual([]);
  });

  it("serves kiosk routes to a paired kiosk only: no credential, sessions and personal tokens are refused", async () => {
    const device = entries("device");
    expect(device.length).toBeGreaterThan(0);
    const session = await signIn(ctx, "ada@knotworking.dev");
    for (const [method, path] of device) {
      const variants: Record<string, string>[] = [
        { origin: "http://localhost:3000" },
        bearer(writeToken),
        { cookie: session.cookie, origin: "http://localhost:3000" },
      ];
      for (const headers of variants) {
        const res = await call(method!, path!, headers);
        expect(res.status, `${method} ${path}`).toBe(401);
        expect((await res.json()).error.code, `${method} ${path}`).toBe("device_required");
      }
    }
  });

  it("serves public routes without any credential", async () => {
    for (const [method, path] of entries("public")) {
      const res = await call(method!, path!, { origin: "http://localhost:3000" });
      expect(res.status, `${method} ${path} must not require a session`).not.toBe(401);
      expect(res.status, `${method} ${path} must not be refused for lack of credentials`).not.toBe(403);
    }
  });
});
