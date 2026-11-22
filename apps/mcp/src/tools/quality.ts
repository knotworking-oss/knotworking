import {
  complaintCategories,
  complaintSources,
  complaintStatuses,
  nonconformanceSources,
  nonconformanceStatuses,
  qualitySeverities,
} from "@knotworking/core";
import { z } from "zod";
import { ToolError, type Api } from "../api";
import type { ToolContext } from "./shared";

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const CREATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const UPDATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const text = (max: number) => z.string().max(max);

const PERSON_ONLY =
  "Closing a complaint, verifying (closing) a non-conformance, completing an audit and recording a mock recall test are a person's sign-offs in the app; there are no tools for them.";

/**
 * Quality module. Agents read the registers and the summary, log complaints, raise and work
 * non-conformances and plan audits. Sign-offs are a person's: no tools.
 */
export function registerQualityTools({ define, slugOf, workspaceParam }: ToolContext) {
  const ws = (api: Api) => api.client.v1.workspaces[":slug"];
  const q = (api: Api) => ws(api).quality;
  define(
    "list_incident_cases",
    {
      module: "quality",
      resource: { name: "incident_cases", op: "list" },
      requiresModules: ["despatch", "production"],
      title: "List live incident cases",
      description:
        "List real incident, withdrawal and recall cases. Requires readable Quality, Despatch and Production. Case containment, evidence and closure are signed-in people’s actions.",
      annotations: READ,
      input: { workspace: workspaceParam, offset: z.number().int().min(0).default(0) },
    },
    async ({ workspace, offset }, api) => {
      const slug = await slugOf(api, workspace);
      return api.call(q(api).incidents.$get({ param: { slug }, query: { offset: String(offset) } }));
    },
  );
  define(
    "get_incident_case",
    {
      module: "quality",
      resource: { name: "incident_cases", op: "get" },
      requiresModules: ["despatch", "production"],
      title: "Get incident case evidence",
      description:
        "Read immutable distribution snapshots, current case holds, contact and disposition evidence, corrections and signed closure. Contact logs do not send messages. Off-site dispositions do not post stock; heed partial snapshot coverage.",
      annotations: READ,
      input: { workspace: workspaceParam, id: z.uuid() },
    },
    async ({ workspace, id }, api) => {
      const slug = await slugOf(api, workspace);
      return api.call(q(api).incidents[":id"].$get({ param: { slug, id } }));
    },
  );

  /** An item by id or exact stock code (case-insensitive). */
  async function resolveItemId(api: Api, slug: string, ref: string) {
    const wanted = ref.trim();
    if (UUID.test(wanted)) return wanted;
    const { items } = await api.call(
      ws(api).items.$get({ param: { slug }, query: { q: wanted, status: "all", limit: "200" } }),
    );
    const match = items.filter((i) => i.code.toLowerCase() === wanted.toLowerCase());
    if (match.length === 1) return match[0]!.id;
    throw new ToolError("not_found", `No item has the code "${wanted}". Use list_items to find it.`);
  }

  /** A lot by id or our lot code (exact, case-insensitive), narrowed to the item when given. */
  async function resolveLotId(api: Api, slug: string, ref: string, itemId?: string) {
    const wanted = ref.trim();
    if (UUID.test(wanted)) return wanted;
    const { lots } = await api.call(
      ws(api).stock.lots.$get({
        param: { slug },
        query: { q: wanted, includeEmpty: "true", limit: "200", ...(itemId ? { itemId } : {}) },
      }),
    );
    const match = lots.filter((l) => l.lotCode.toLowerCase() === wanted.toLowerCase());
    if (match.length === 1) return match[0]!.id;
    throw new ToolError(
      match.length ? "ambiguous" : "not_found",
      match.length
        ? `Several items have a lot "${wanted}"; pass \`item\` too.`
        : `No lot on record has the code "${wanted}". Pass it as \`reported_lot_code\` instead, or use list_stock_lots.`,
    );
  }

  /** Looks a record up by reference: CMP- complaints, NC- non-conformances, IA- audits, MR- recall tests. */
  async function findByReference(api: Api, slug: string, reference: string) {
    const ref = reference.trim().toUpperCase();
    const prefix = ref.split("-")[0];
    const notFound = () =>
      new ToolError(
        "not_found",
        `Nothing has the reference "${reference}". References look like CMP-2026-004.`,
      );
    if (prefix === "CMP") {
      const { complaints } = await api.call(q(api).complaints.$get({ param: { slug }, query: { q: ref } }));
      const hit = complaints.find((c) => c.reference === ref);
      if (!hit) throw notFound();
      return { kind: "complaint" as const, id: hit.id };
    }
    if (prefix === "NC") {
      const { nonconformances } = await api.call(
        q(api).nonconformances.$get({ param: { slug }, query: { q: ref } }),
      );
      const hit = nonconformances.find((n) => n.reference === ref);
      if (!hit) throw notFound();
      return { kind: "nonconformance" as const, id: hit.id };
    }
    if (prefix === "IA") {
      const { audits } = await api.call(q(api).audits.$get({ param: { slug }, query: { q: ref } }));
      const hit = audits.find((a) => a.reference === ref);
      if (!hit) throw notFound();
      return { kind: "audit" as const, id: hit.id };
    }
    if (prefix === "MR") {
      const { recallTests } = await api.call(
        q(api)["recall-tests"].$get({ param: { slug }, query: { q: ref, includeVoided: "true" } }),
      );
      const hit = recallTests.find((r) => r.reference === ref);
      if (!hit) throw notFound();
      return { kind: "recall_test" as const, id: hit.id };
    }
    throw notFound();
  }

  type Complaint = Awaited<ReturnType<typeof getComplaint>>;
  const getComplaint = (api: Api, slug: string, id: string) =>
    api.call(q(api).complaints[":id"].$get({ param: { slug, id } }));
  type Nonconformance = Awaited<ReturnType<typeof getNonconformance>>;
  const getNonconformance = (api: Api, slug: string, id: string) =>
    api.call(q(api).nonconformances[":id"].$get({ param: { slug, id } }));

  const item = (i: { code: string; name: string } | null) => (i ? `${i.code} ${i.name}` : null);

  /** No contact details: an agent has no need to reach the complainant directly. */
  const complaintView = (
    c: Complaint | Awaited<ReturnType<typeof listComplaints>>["complaints"][number],
  ) => ({
    reference: c.reference,
    receivedOn: c.receivedOn,
    status: c.status,
    source: c.source,
    category: c.category,
    severity: c.severity,
    customer: c.customer,
    complainant: c.complainantName,
    item: item(c.item),
    lot: c.lot?.lotCode ?? null,
    reportedLotCode: c.reportedLotCode,
    description: c.description,
    investigation: c.investigation,
    rootCause: c.rootCause,
    response: c.response,
    justified: c.justified,
    closed: c.closedAt ? { by: c.closedByName, at: c.closedAt, note: c.closeNote } : null,
    nonconformanceCount: c.nonconformanceCount,
  });
  const listComplaints = (api: Api, slug: string, query: Record<string, string>) =>
    api.call(q(api).complaints.$get({ param: { slug }, query }));

  const ncView = (n: Nonconformance) => ({
    reference: n.reference,
    raisedOn: n.raisedOn,
    status: n.status,
    source: n.source,
    severity: n.severity,
    title: n.title,
    description: n.description,
    complaint: n.complaint?.reference ?? null,
    audit: n.audit ? `${n.audit.reference} ${n.audit.title}` : null,
    item: item(n.item),
    lot: n.lot?.lotCode ?? null,
    supplier: n.supplier?.name ?? null,
    containment: n.containment,
    rootCause: n.rootCause,
    correctiveAction: n.correctiveAction,
    preventiveAction: n.preventiveAction,
    owner: n.owner?.name ?? null,
    dueOn: n.dueOn,
    overdue: n.overdue,
    verified: n.closedAt ? { by: n.closedByName, at: n.closedAt, note: n.verificationNote } : null,
  });

  define(
    "get_quality_summary",
    {
      module: "quality",
      title: "Quality summary",
      description:
        "What needs attention in quality: open and investigating complaints, complaints by category over 12 months, open, overdue and awaiting-verification non-conformances, overdue and upcoming internal audits, and the yearly mock recall test (last result, when the next is due).",
      annotations: READ,
      input: { workspace: workspaceParam },
    },
    async ({ workspace }, api) => {
      const slug = await slugOf(api, workspace);
      const [summary, recent] = await Promise.all([
        api.call(q(api).summary.$get({ param: { slug } })),
        api.call(q(api)["recall-tests"].$get({ param: { slug }, query: { limit: "5" } })),
      ]);
      return {
        ...summary,
        recentRecallTests: recent.recallTests.map((r) => ({
          reference: r.reference,
          conductedOn: r.conductedOn,
          lot: r.lot ? `${r.lot.lotCode} (${item(r.lot.item)})` : null,
          durationMinutes: r.durationMinutes,
          reconciledPercent: r.reconciledPercent,
          passed: r.passed,
        })),
      };
    },
  );

  define(
    "list_complaints",
    {
      module: "quality",
      resource: { name: "complaints", op: "list" },
      title: "List complaints",
      description:
        "The complaints register, newest first. Filter by status (`unresolved` = open or investigating), category, severity, item, lot, dates or text. Complainants' contact details are never returned.",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        status: z.enum([...complaintStatuses, "unresolved", "all"]).optional(),
        category: z.enum(complaintCategories).optional(),
        severity: z.enum(qualitySeverities).optional(),
        item: z.string().max(60).optional().describe("Item id or stock code."),
        from: isoDate.optional(),
        to: isoDate.optional(),
        search: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const itemId = a.item ? await resolveItemId(api, slug, a.item) : undefined;
      const page = await listComplaints(api, slug, {
        ...(a.status ? { status: a.status } : {}),
        ...(a.category ? { category: a.category } : {}),
        ...(a.severity ? { severity: a.severity } : {}),
        ...(itemId ? { itemId } : {}),
        ...(a.from ? { from: a.from } : {}),
        ...(a.to ? { to: a.to } : {}),
        ...(a.search ? { q: a.search } : {}),
        limit: String(a.limit ?? 50),
      });
      return { total: page.total, complaints: page.complaints.map(complaintView) };
    },
  );

  define(
    "list_nonconformances",
    {
      module: "quality",
      resource: { name: "nonconformances", op: "list" },
      title: "List non-conformances",
      description:
        "The non-conformance (CAPA) register, newest first. Status `open`, `action_taken` (awaiting a manager's verification), `closed`, `unresolved` or `overdue`. Filter by source, severity or text.",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        status: z.enum([...nonconformanceStatuses, "unresolved", "overdue", "all"]).optional(),
        source: z.enum(nonconformanceSources).optional(),
        severity: z.enum(qualitySeverities).optional(),
        search: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const page = await api.call(
        q(api).nonconformances.$get({
          param: { slug },
          query: {
            ...(a.status ? { status: a.status } : {}),
            ...(a.source ? { source: a.source } : {}),
            ...(a.severity ? { severity: a.severity } : {}),
            ...(a.search ? { q: a.search } : {}),
            limit: String(a.limit ?? 50),
          },
        }),
      );
      return { total: page.total, nonconformances: page.nonconformances.map(ncView) };
    },
  );

  define(
    "list_quality_audits",
    {
      module: "quality",
      resource: { name: "quality_audits", op: "list" },
      title: "List internal audits",
      description:
        "The internal audit schedule, latest planned date first, with each audit's state (overdue, soon, planned, completed, cancelled) and how many findings it raised and how many are still open.",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        status: z.enum(["planned", "completed", "cancelled", "all"]).optional(),
        from: isoDate.optional(),
        to: isoDate.optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const page = await api.call(
        q(api).audits.$get({
          param: { slug },
          query: {
            ...(a.status ? { status: a.status } : {}),
            ...(a.from ? { from: a.from } : {}),
            ...(a.to ? { to: a.to } : {}),
            limit: "200",
          },
        }),
      );
      return {
        total: page.total,
        audits: page.audits.map((x) => ({
          reference: x.reference,
          title: x.title,
          scope: x.scope,
          plannedOn: x.plannedOn,
          state: x.state,
          auditor: x.auditor?.name ?? x.auditorName,
          completedOn: x.completedOn,
          summary: x.summary,
          cancelReason: x.cancelReason,
          findings: x.findings,
        })),
      };
    },
  );

  define(
    "get_quality_record",
    {
      module: "quality",
      resource: { name: "quality_records", op: "get" },
      title: "Get a quality record",
      description:
        "One complaint (CMP-…), non-conformance (NC-…), internal audit (IA-…) or mock recall test (MR-…) in full, by its reference, with the non-conformances raised from it.",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        reference: z.string().min(3).max(40).describe("e.g. CMP-2026-004"),
      },
    },
    async ({ workspace, reference }, api) => {
      const slug = await slugOf(api, workspace);
      const found = await findByReference(api, slug, reference);
      if (found.kind === "complaint") {
        const c = await getComplaint(api, slug, found.id);
        return { kind: found.kind, ...complaintView(c), nonconformances: c.nonconformances };
      }
      if (found.kind === "nonconformance") {
        return { kind: found.kind, ...ncView(await getNonconformance(api, slug, found.id)) };
      }
      if (found.kind === "audit") {
        const x = await api.call(q(api).audits[":id"].$get({ param: { slug, id: found.id } }));
        return {
          kind: found.kind,
          reference: x.reference,
          title: x.title,
          scope: x.scope,
          plannedOn: x.plannedOn,
          state: x.state,
          auditor: x.auditor?.name ?? x.auditorName,
          completedOn: x.completedOn,
          completedBy: x.completedByName,
          summary: x.summary,
          cancelReason: x.cancelReason,
          findings: x.nonconformances,
        };
      }
      const r = await api.call(q(api)["recall-tests"][":id"].$get({ param: { slug, id: found.id } }));
      return {
        kind: found.kind,
        reference: r.reference,
        conductedOn: r.conductedOn,
        direction: r.direction,
        scenario: r.scenario,
        lot: r.lot ? `${r.lot.lotCode} (${item(r.lot.item)})` : null,
        startedAt: r.startedAt,
        completedAt: r.completedAt,
        durationMinutes: r.durationMinutes,
        quantityExpected: r.quantityExpected,
        quantityTraced: r.quantityTraced,
        unit: r.unit,
        reconciledPercent: r.reconciledPercent,
        passed: r.passed,
        notes: r.notes,
        recordedBy: r.recordedByName,
        voided: r.voidedAt ? { by: r.voidedByName, at: r.voidedAt, reason: r.voidReason } : null,
      };
    },
  );

  define(
    "log_complaint",
    {
      module: "quality",
      title: "Log a complaint",
      description: `Log a complaint received from a consumer, customer, retailer or regulator (or raised internally). A critical complaint, or a major one about food safety (foreign body, allergen, illness, microbiological), opens a non-conformance at once. ${PERSON_ONLY}`,
      annotations: CREATE,
      input: {
        workspace: workspaceParam,
        received_on: isoDate.describe("YYYY-MM-DD, not in the future."),
        source: z.enum(complaintSources),
        category: z.enum(complaintCategories),
        severity: z.enum(qualitySeverities).optional().describe("Default minor."),
        description: text(8000).min(1),
        item: z.string().max(60).optional().describe("Item id or stock code."),
        lot: z
          .string()
          .max(100)
          .optional()
          .describe("Our lot code or lot id, when it matches a lot on record."),
        reported_lot_code: text(100)
          .optional()
          .describe("The lot or date code as the complainant reported it."),
        customer: text(200).optional().describe("The customer account, e.g. a retailer."),
        complainant_name: text(200).optional(),
        complainant_contact: text(500).optional().describe("Stored for the team; never returned to agents."),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const itemId = a.item ? await resolveItemId(api, slug, a.item) : undefined;
      const lotId = a.lot ? await resolveLotId(api, slug, a.lot, itemId) : undefined;
      const c = await api.call(
        q(api).complaints.$post({
          param: { slug },
          json: {
            receivedOn: a.received_on,
            source: a.source,
            category: a.category,
            ...(a.severity ? { severity: a.severity } : {}),
            description: a.description,
            ...(itemId ? { itemId } : {}),
            ...(lotId ? { lotId } : {}),
            ...(a.reported_lot_code ? { reportedLotCode: a.reported_lot_code } : {}),
            ...(a.customer ? { customer: a.customer } : {}),
            ...(a.complainant_name ? { complainantName: a.complainant_name } : {}),
            ...(a.complainant_contact ? { complainantContact: a.complainant_contact } : {}),
          },
        }),
      );
      return { ...complaintView(c), nonconformancesOpened: c.nonconformances };
    },
  );

  define(
    "update_complaint",
    {
      module: "quality",
      title: "Update a complaint",
      description: `Record the investigation, root cause, response or whether it was justified, or move a complaint between open and investigating. Only fields given change; an empty string clears one. A closed complaint can't be changed. ${PERSON_ONLY}`,
      annotations: UPDATE,
      input: {
        workspace: workspaceParam,
        reference: z.string().min(3).max(40).describe("e.g. CMP-2026-004"),
        status: z.enum(["open", "investigating"]).optional(),
        severity: z.enum(qualitySeverities).optional(),
        investigation: text(8000).optional(),
        root_cause: text(4000).optional(),
        response: text(4000).optional().describe("What was said or sent to the complainant."),
        justified: z.boolean().optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const found = await findByReference(api, slug, a.reference);
      if (found.kind !== "complaint")
        throw new ToolError("invalid_input", `${a.reference} is not a complaint`);
      const json = {
        ...(a.status ? { status: a.status } : {}),
        ...(a.severity ? { severity: a.severity } : {}),
        ...(a.investigation !== undefined ? { investigation: a.investigation } : {}),
        ...(a.root_cause !== undefined ? { rootCause: a.root_cause } : {}),
        ...(a.response !== undefined ? { response: a.response } : {}),
        ...(a.justified !== undefined ? { justified: a.justified } : {}),
      };
      if (!Object.keys(json).length) throw new ToolError("invalid_input", "Nothing to update");
      const c = await api.call(q(api).complaints[":id"].$patch({ param: { slug, id: found.id }, json }));
      return complaintView(c);
    },
  );

  define(
    "raise_nonconformance",
    {
      module: "quality",
      title: "Raise a non-conformance",
      description: `Raise a non-conformance: something that went wrong in the process, a product or with a supplier, or from a complaint (pass its reference). The due date defaults by severity (critical 7 days, major 28, minor 56). ${PERSON_ONLY}`,
      annotations: CREATE,
      input: {
        workspace: workspaceParam,
        raised_on: isoDate.describe("YYYY-MM-DD, not in the future."),
        source: z.enum(["process", "product", "supplier", "complaint", "other"]),
        severity: z.enum(qualitySeverities).optional().describe("Default minor."),
        title: text(200).min(1),
        description: text(8000).min(1),
        complaint: z.string().max(40).optional().describe("The complaint's reference, for source complaint."),
        item: z.string().max(60).optional().describe("Item id or stock code."),
        lot: z.string().max(100).optional().describe("Lot code or id."),
        containment: text(4000).optional().describe("What was done straight away."),
        due_on: isoDate.optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      let complaintId: string | undefined;
      if (a.complaint) {
        const found = await findByReference(api, slug, a.complaint);
        if (found.kind !== "complaint")
          throw new ToolError("invalid_input", `${a.complaint} is not a complaint`);
        complaintId = found.id;
      }
      if ((a.source === "complaint") !== Boolean(complaintId))
        throw new ToolError("invalid_input", "Pass `complaint` exactly when the source is complaint");
      const itemId = a.item ? await resolveItemId(api, slug, a.item) : undefined;
      const lotId = a.lot ? await resolveLotId(api, slug, a.lot, itemId) : undefined;
      const n = await api.call(
        q(api).nonconformances.$post({
          param: { slug },
          json: {
            raisedOn: a.raised_on,
            source: a.source,
            ...(a.severity ? { severity: a.severity } : {}),
            title: a.title,
            description: a.description,
            ...(complaintId ? { complaintId } : {}),
            ...(itemId ? { itemId } : {}),
            ...(lotId ? { lotId } : {}),
            ...(a.containment ? { containment: a.containment } : {}),
            ...(a.due_on ? { dueOn: a.due_on } : {}),
          },
        }),
      );
      return ncView(n);
    },
  );

  define(
    "update_nonconformance",
    {
      module: "quality",
      title: "Update a non-conformance",
      description: `Record containment, root cause, corrective and preventive action, or move it to \`action_taken\` (needs a corrective action) so a manager can verify it, or back to \`open\`. Only fields given change; an empty string clears one. ${PERSON_ONLY}`,
      annotations: UPDATE,
      input: {
        workspace: workspaceParam,
        reference: z.string().min(3).max(40).describe("e.g. NC-2026-012"),
        status: z.enum(["open", "action_taken"]).optional(),
        severity: z.enum(qualitySeverities).optional(),
        containment: text(4000).optional(),
        root_cause: text(4000).optional(),
        corrective_action: text(4000).optional(),
        preventive_action: text(4000).optional(),
        due_on: isoDate.optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const found = await findByReference(api, slug, a.reference);
      if (found.kind !== "nonconformance")
        throw new ToolError("invalid_input", `${a.reference} is not a non-conformance`);
      const json = {
        ...(a.status ? { status: a.status } : {}),
        ...(a.severity ? { severity: a.severity } : {}),
        ...(a.containment !== undefined ? { containment: a.containment } : {}),
        ...(a.root_cause !== undefined ? { rootCause: a.root_cause } : {}),
        ...(a.corrective_action !== undefined ? { correctiveAction: a.corrective_action } : {}),
        ...(a.preventive_action !== undefined ? { preventiveAction: a.preventive_action } : {}),
        ...(a.due_on ? { dueOn: a.due_on } : {}),
      };
      if (!Object.keys(json).length) throw new ToolError("invalid_input", "Nothing to update");
      const n = await api.call(q(api).nonconformances[":id"].$patch({ param: { slug, id: found.id }, json }));
      return ncView(n);
    },
  );

  define(
    "plan_quality_audit",
    {
      module: "quality",
      title: "Plan an internal audit",
      description: `Add an internal audit to the schedule: what it covers (an area, a process, BRCGS clauses), when, and who audits (a name). ${PERSON_ONLY}`,
      annotations: CREATE,
      input: {
        workspace: workspaceParam,
        title: text(200).min(1),
        planned_on: isoDate,
        scope: text(4000).optional(),
        auditor: text(200).optional().describe("The auditor's name."),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const x = await api.call(
        q(api).audits.$post({
          param: { slug },
          json: {
            title: a.title,
            plannedOn: a.planned_on,
            ...(a.scope ? { scope: a.scope } : {}),
            ...(a.auditor ? { auditorName: a.auditor } : {}),
          },
        }),
      );
      return { reference: x.reference, title: x.title, plannedOn: x.plannedOn, state: x.state };
    },
  );

  define(
    "get_complaint_trends",
    {
      module: "quality",
      title: "Complaint trends per million units",
      description:
        "Complaints per million units sold, per month: overall, per product and per complaint category. Units are the monthly sales volumes people entered per product; a month without units has no rate (null).",
      annotations: READ,
      input: { workspace: workspaceParam, months: z.number().int().min(1).max(36).optional() },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      return api.call(q(api).trends.$get({ param: { slug }, query: { months: String(a.months ?? 12) } }));
    },
  );

  define(
    "get_supplier_quality",
    {
      module: "quality",
      title: "A supplier's open non-conformances",
      description:
        "A supplier's open non-conformances beside its approval status, with whether they suggest looking at suspending it. A suggestion only: approving or suspending a supplier is a person's decision.",
      annotations: READ,
      input: { workspace: workspaceParam, supplier_id: z.string().regex(UUID) },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      return api.call(q(api).suppliers[":id"].$get({ param: { slug, id: a.supplier_id } }));
    },
  );

  define(
    "list_audit_programmes",
    {
      module: "quality",
      resource: { name: "audit_programmes", op: "list" },
      title: "Recurring audit programmes",
      description:
        "The recurring internal audit programme: what is audited, how often and when the next audit is planned. The sweep plans each audit ahead as a planned audit.",
      annotations: READ,
      input: { workspace: workspaceParam },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      return api.call(q(api)["audit-programmes"].$get({ param: { slug } }));
    },
  );
}
