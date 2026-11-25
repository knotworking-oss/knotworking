import type { ModuleId } from "@knotworking/core";

/**
 * Which module owns each workspace route, by its path below `/v1/workspaces/:slug`.
 *
 * The first matching rule wins, so the more specific rules (time tracking under `/tasks/:id/…`)
 * come first. `platform` routes are always on; they filter module data themselves (bootstrap,
 * sync, search, attachments, notifications). A path that matches no rule is refused at runtime
 * and fails `module-routes.test.ts`, so a new route can't ship unclassified.
 *
 * Works on concrete paths (`/tasks/0190…/timer`) and on route patterns (`/tasks/:id/timer`).
 */
const RULES: readonly [RegExp, ModuleId | "platform"][] = [
  [/^\/accounting(\/|$)/, "accounting"],
  // Dashboards: the catalogue and queries. Each query also checks the modules its dataset reads.
  [/^\/bi(\/|$)/, "bi"],
  [/^\/workforce\/hr(\/|$)/, "workforce_hr"],
  [/^\/workforce(\/|$)/, "workforce"],
  // Time tracking.
  [/^\/tasks\/[^/]+\/(time-entries|timer)$/, "time"],
  [/^\/time-entries(\/|$)/, "time"],
  [/^\/timer\/stop$/, "time"],
  [/^\/projects\/[^/]+\/time$/, "time"],
  [/^\/time-report(\.csv)?$/, "time"],
  // Tasks and projects (workflow states and labels are task configuration).
  [/^\/tasks(\/|$)/, "tasks"],
  [/^\/task-relations(\/|$)/, "tasks"],
  [/^\/comments(\/|$)/, "tasks"],
  [/^\/projects(\/|$)/, "tasks"],
  [/^\/labels(\/|$)/, "tasks"],
  [/^\/states(\/|$)/, "tasks"],
  [/^\/teams\/[^/]+\/states$/, "tasks"],
  // Documents.
  [/^\/documents(\/|$)/, "docs"],
  // Calendar and meetings.
  [/^\/calendar$/, "calendar"],
  [/^\/meetings(\/|$)/, "calendar"],
  // Assets: the shared register of areas, equipment, vehicles, IT and tools.
  [/^\/assets(\/|$)/, "assets"],
  // Items and suppliers.
  [/^\/items(\/|$)/, "items"],
  [/^\/suppliers(\/|$)/, "items"],
  // Recipes.
  [/^\/recipes(\/|$)/, "recipes"],
  // SOPs.
  [/^\/sops(\/|$)/, "sops"],
  // Stock: locations, lots and the movement ledger.
  [/^\/stock(\/|$)/, "stock"],
  [/^\/customers(\/|$)/, "customers"],
  [/^\/despatch(\/|$)/, "despatch"],
  [/^\/sales(\/|$)/, "sales"],
  [/^\/client-services(\/|$)/, "client_services"],
  [/^\/hse\/incidents(\/|$)/, "hse_incidents"],
  [/^\/hse(\/|$)/, "hse"],
  // Demand planning.
  [/^\/demand(\/|$)/, "demand"],
  // Production: batches, batch records, material requirements and lot tracing.
  [/^\/production(\/|$)/, "production"],
  // Food safety records: HACCP plans, CCP logs, corrective actions, cleaning and calibration.
  [/^\/haccp(\/|$)/, "haccp"],
  // People: the staff register, job roles and kiosk PINs.
  [/^\/people(\/|$)/, "people"],
  // Training: courses, the matrix and training records.
  [/^\/training(\/|$)/, "training"],
  // Attendance: clocking, shifts, payroll, the on-site register, roll calls, visitors and kiosks.
  [/^\/attendance(\/|$)/, "attendance"],
  // Quality: complaints, non-conformances, internal audits and mock recall tests.
  [/^\/quality(\/|$)/, "quality"],
  // Purchasing: purchase orders, goods-in against them, suggestions and supplier performance.
  [/^\/purchasing(\/|$)/, "purchasing"],
  [/^\/purchase-requests(\/|$)/, "purchase_requests"],
  // Costing: batch costs, lot costs and standard against actual (all reads).
  [/^\/costing(\/|$)/, "costing"],
  // Site programmes: pest control, glass register, planned maintenance, storage temperatures, checklists.
  [/^\/site(\/|$)/, "site"],
  // Labels and nutrition: items' labelling data, computed declarations and product labels. Under
  // `/labelling` because `/labels` are task labels.
  [/^\/labelling(\/|$)/, "labels"],
  // Specifications: controlled ingredient, packaging and product specifications.
  [/^\/specifications(\/|$)/, "specifications"],
  // Testing: laboratories, sampling points, plans, samples, results, investigations and trends.
  [/^\/testing(\/|$)/, "testing"],
  // Product development: projects, trials, sign-offs and launch.
  [/^\/npd(\/|$)/, "npd"],
  // Food defence: threat assessments, security controls and checks, exercises.
  [/^\/defence(\/|$)/, "defence"],
  // Governance: objectives, culture plan, requirements, confidential concerns, management reviews.
  [/^\/governance(\/|$)/, "governance"],
  // Raising a confidential concern is open to every member; the routes check Governance is on.
  [/^\/concerns(\/|$)/, "platform"],
  // Assistant: the member's own conversations (their provider keys are under /v1/me).
  [/^\/assistant(\/|$)/, "assistant"],
  // Platform.
  [/^\/(bootstrap|sync|events|search|modules|module-settings|settings)$/, "platform"],
  [/^\/(members|invitations|teams|attachments|notifications|token-actions)(\/|$)/, "platform"],
];

export function moduleOfRoute(subPath: string): ModuleId | "platform" | undefined {
  return RULES.find(([pattern]) => pattern.test(subPath))?.[1];
}

/** The part of a request or route path below `/v1/workspaces/:slug`, or `null` if it isn't one. */
export function workspaceSubPath(path: string): string | null {
  return /^\/v1\/workspaces\/[^/]+(\/.*)$/.exec(path)?.[1] ?? null;
}
