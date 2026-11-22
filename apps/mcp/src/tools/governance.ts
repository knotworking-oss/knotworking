import {
  draftableStatuses,
  clauseAssessmentStatuses,
  evidenceCheckIds,
  governanceCultureKinds,
  governanceObjectiveCategories,
  governanceObjectiveRags,
  governanceObjectiveStatuses,
  governanceRequirementSources,
  newId,
} from "@knotworking/core";
import { z } from "zod";
import { ToolError, type Api } from "../api";
import { fetchBootstrap } from "../model";
import type { ToolContext } from "./shared";

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const CREATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERSON_NOTE =
  "Signing a management review, recording a compliance review or a clause assessment, and raising, reading or handling confidential concerns are done by people in the Knotworking app; there are no tools for them.";

/**
 * Governance: objectives, the culture plan, the requirement register and management reviews.
 * Agents may prepare records and read the evidence; people sign. Confidential concerns are never
 * available to agents.
 */
export function registerGovernanceTools({ define, slugOf, workspaceParam }: ToolContext) {
  const ws = (api: Api) => api.client.v1.workspaces[":slug"];

  /** A member by id, email or exact name. */
  async function resolveMember(api: Api, slug: string, ref: string | null | undefined) {
    if (ref === undefined || ref === null) return ref;
    const wanted = ref.trim();
    if (UUID.test(wanted)) return wanted;
    const { members } = await api.call(ws(api).members.$get({ param: { slug } }));
    const match = members.filter(
      (m) => m.email.toLowerCase() === wanted.toLowerCase() || m.name.toLowerCase() === wanted.toLowerCase(),
    );
    if (match.length === 1) return match[0]!.userId;
    throw new ToolError("not_found", `No member matches "${wanted}" (use an email or exact name).`);
  }

  async function resolveByTitle<T extends { id: string; title: string }>(
    rows: T[],
    ref: string,
    what: string,
  ) {
    const wanted = ref.trim();
    if (UUID.test(wanted)) return wanted;
    const match = rows.filter((r) => r.title.toLowerCase() === wanted.toLowerCase());
    if (match.length === 1) return match[0]!.id;
    throw new ToolError("not_found", `No ${what} is titled "${wanted}".`);
  }

  define(
    "get_governance_overview",
    {
      module: "governance",
      title: "Get governance overview",
      description:
        "What needs attention in governance: objectives overdue, at risk or off track; culture activities overdue and coming up; requirements due for review, not assessed or not compliant; draft management reviews and the last signed one. Confidential concerns are not included.",
      annotations: READ,
      input: { workspace: workspaceParam },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const o = await api.call(ws(api).governance.overview.$get({ param: { slug } }));
      return {
        objectives: o.objectivesNeedingAttention.map((x) => ({
          title: x.title,
          dueOn: x.dueOn,
          dueStatus: x.dueStatus,
          rag: x.latest?.rag ?? null,
          owner: x.ownerName,
        })),
        cultureOverdue: o.cultureOverdue.map((x) => ({ title: x.title, plannedOn: x.plannedOn })),
        cultureUpcoming: o.cultureUpcoming.map((x) => ({ title: x.title, plannedOn: x.plannedOn })),
        requirements: o.requirementsDue.map((x) => ({
          title: x.title,
          reference: x.reference,
          compliance: x.compliance,
          reviewDueOn: x.reviewDueOn,
        })),
        draftReviews: o.draftReviews.map((r) => ({ id: r.id, title: r.title })),
        lastSignedReview: o.lastSignedReview,
      };
    },
  );

  define(
    "list_governance_objectives",
    {
      module: "governance",
      resource: { name: "governance_objectives", op: "list" },
      title: "List food safety and quality objectives",
      description:
        "Objectives with category, measure, target, owner, due date and status, and the latest progress report (RAG, value, note).",
      annotations: READ,
      input: { workspace: workspaceParam },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const { objectives } = await api.call(ws(api).governance.objectives.$get({ param: { slug } }));
      return {
        objectives: objectives.map((o) => ({
          id: o.id,
          title: o.title,
          category: o.category,
          measure: o.measure,
          target: o.target,
          owner: o.ownerName,
          dueOn: o.dueOn,
          status: o.status,
          dueStatus: o.dueStatus,
          latest: o.latest
            ? { on: o.latest.on, rag: o.latest.rag, value: o.latest.value, note: o.latest.note }
            : null,
        })),
      };
    },
  );

  define(
    "save_governance_objective",
    {
      module: "governance",
      title: "Save food safety or quality objective",
      description:
        "Creates an objective (give `title` and `category`) or updates one (give `objective`, an id or exact title). Owner by email or name. Fields left out are unchanged. Use `progress` to add a progress report at the same time.",
      annotations: CREATE,
      input: {
        workspace: workspaceParam,
        objective: z.string().max(200).optional(),
        title: z.string().min(1).max(200).optional(),
        category: z.enum(governanceObjectiveCategories).optional(),
        measure: z.string().max(2000).nullable().optional(),
        target: z.string().max(500).nullable().optional(),
        owner: z.string().max(200).nullable().optional(),
        due_on: z.string().date().nullable().optional(),
        status: z.enum(governanceObjectiveStatuses).optional(),
        progress: z
          .object({
            on: z.string().date(),
            rag: z.enum(governanceObjectiveRags),
            value: z.string().max(200).optional(),
            note: z.string().min(1).max(2000),
          })
          .optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const fields = {
        ...(a.title ? { title: a.title } : {}),
        ...(a.category ? { category: a.category } : {}),
        ...(a.measure !== undefined ? { measure: a.measure } : {}),
        ...(a.target !== undefined ? { target: a.target } : {}),
        ...(a.owner !== undefined ? { ownerUserId: (await resolveMember(api, slug, a.owner)) ?? null } : {}),
        ...(a.due_on !== undefined ? { dueOn: a.due_on } : {}),
      };
      let id: string;
      let saved;
      if (a.objective) {
        const { objectives } = await api.call(ws(api).governance.objectives.$get({ param: { slug } }));
        id = await resolveByTitle(objectives, a.objective, "objective");
        const patch = { ...fields, ...(a.status ? { status: a.status } : {}) };
        saved = Object.keys(patch).length
          ? await api.call(ws(api).governance.objectives[":id"].$patch({ param: { slug, id }, json: patch }))
          : objectives.find((o) => o.id === id);
      } else {
        if (!a.title || !a.category)
          throw new ToolError(
            "invalid_input",
            "Give `title` and `category` for a new objective, or `objective`.",
          );
        saved = await api.call(
          ws(api).governance.objectives.$post({
            param: { slug },
            json: { ...fields, title: a.title, category: a.category },
          }),
        );
        id = saved.id;
      }
      if (a.progress)
        saved = await api.call(
          ws(api).governance.objectives[":id"].progress.$post({ param: { slug, id }, json: a.progress }),
        );
      return {
        id,
        title: saved?.title,
        status: saved?.status,
        dueStatus: saved?.dueStatus,
        latest: saved?.latest ?? null,
      };
    },
  );

  define(
    "list_culture_activities",
    {
      module: "governance",
      resource: { name: "culture_activities", op: "list" },
      title: "List food safety culture activities",
      description:
        "The food safety culture plan: activities (surveys, briefings, communications, recognition, workshops, leadership walks) with planned date, owner, how they are measured, and when done, participants and result. State is planned, overdue, done or cancelled.",
      annotations: READ,
      input: { workspace: workspaceParam },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const { activities } = await api.call(ws(api).governance.culture.$get({ param: { slug } }));
      return {
        activities: activities.map((x) => ({
          id: x.id,
          title: x.title,
          kind: x.kind,
          plannedOn: x.plannedOn,
          owner: x.ownerName,
          measure: x.measure,
          state: x.state,
          completedOn: x.completedOn,
          participants: x.participants,
          result: x.result,
        })),
      };
    },
  );

  define(
    "save_culture_activity",
    {
      module: "governance",
      title: "Save food safety culture activity",
      description:
        "Plans a culture activity (give `title`, `kind`, `planned_on`) or updates one (give `activity`, an id or exact title), including recording it done with `completed_on`, `participants` and `result`.",
      annotations: CREATE,
      input: {
        workspace: workspaceParam,
        activity: z.string().max(200).optional(),
        title: z.string().min(1).max(200).optional(),
        kind: z.enum(governanceCultureKinds).optional(),
        planned_on: z.string().date().optional(),
        owner: z.string().max(200).nullable().optional(),
        measure: z.string().max(2000).nullable().optional(),
        completed_on: z.string().date().nullable().optional(),
        participants: z.number().int().min(0).nullable().optional(),
        result: z.string().max(4000).nullable().optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const fields = {
        ...(a.title ? { title: a.title } : {}),
        ...(a.kind ? { kind: a.kind } : {}),
        ...(a.planned_on ? { plannedOn: a.planned_on } : {}),
        ...(a.owner !== undefined ? { ownerUserId: (await resolveMember(api, slug, a.owner)) ?? null } : {}),
        ...(a.measure !== undefined ? { measure: a.measure } : {}),
      };
      const done = {
        ...(a.completed_on !== undefined ? { completedOn: a.completed_on } : {}),
        ...(a.participants !== undefined ? { participants: a.participants } : {}),
        ...(a.result !== undefined ? { result: a.result } : {}),
      };
      if (a.activity) {
        const { activities } = await api.call(ws(api).governance.culture.$get({ param: { slug } }));
        const id = await resolveByTitle(activities, a.activity, "culture activity");
        const x = await api.call(
          ws(api).governance.culture[":id"].$patch({ param: { slug, id }, json: { ...fields, ...done } }),
        );
        return { id: x.id, title: x.title, state: x.state };
      }
      if (!a.title || !a.kind || !a.planned_on)
        throw new ToolError(
          "invalid_input",
          "Give `title`, `kind` and `planned_on` for a new activity, or `activity`.",
        );
      const x = await api.call(
        ws(api).governance.culture.$post({
          param: { slug },
          json: { ...fields, title: a.title, kind: a.kind, plannedOn: a.planned_on },
        }),
      );
      return { id: x.id, title: x.title, state: x.state };
    },
  );

  /** A standard by id, or by code and optional issue ("BRCGS-FS", "BRCGS-FS 9"). */
  async function resolveStandard(api: Api, slug: string, ref: string) {
    const wanted = ref.trim();
    if (UUID.test(wanted)) return wanted;
    const { standards } = await api.call(ws(api).governance.standards.$get({ param: { slug } }));
    const [code, issue] = wanted.split(/\s+(?:issue\s+)?/i);
    const match = standards.filter(
      (s) =>
        s.code.toLowerCase() === code!.toLowerCase() &&
        (issue ? s.issue.toLowerCase() === issue.toLowerCase() : s.status === "active"),
    );
    if (match.length === 1) return match[0]!.id;
    throw new ToolError(
      match.length ? "ambiguous" : "not_found",
      match.length
        ? `Several issues of ${code} are active: name the issue, e.g. "${code} 9".`
        : `No standard matches "${wanted}". Use list_standards.`,
    );
  }

  define(
    "list_standards",
    {
      module: "governance",
      resource: { name: "standards", op: "list" },
      title: "List standards in the gap analysis library",
      description:
        "Standards and issues in the library (e.g. BRCGS Food Safety Issue 9, a customer code): how many clauses each has, how many are assessed, counts by status (compliant, partial, gap, not applicable, not assessed), open and overdue findings, and fundamental clauses not yet compliant. Clause text comes from the workspace's own licensed copy; none ships with the software.",
      annotations: READ,
      input: { workspace: workspaceParam },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      return api.call(ws(api).governance.standards.$get({ param: { slug } }));
    },
  );

  define(
    "get_gap_analysis",
    {
      module: "governance",
      title: "Get a standard's gap analysis",
      description:
        "A standard's gap analysis: the summary (by status and section, assessed %, open and overdue findings, fundamental clauses at risk, clauses whose evidence shows a gap and conflicts where a clause assessed compliant has failing evidence) and its clauses in clause order with text, each mapped evidence check's live result, the latest assessment (status, note, owner, due date, who assessed it and when) and tasks raised to close findings. Filters narrow the clause list, never the summary. Assessing a clause is done by a person in the app; use this to read the evidence position and draft notes for them.",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        standard: z.string().min(1).max(200).describe('Standard id, or code and issue, e.g. "BRCGS-FS 9".'),
        status: z.enum(clauseAssessmentStatuses).optional(),
        section: z.string().max(40).optional(),
        fundamental_only: z.boolean().optional(),
        evidence: z
          .enum(["gap", "conflict", "none"])
          .optional()
          .describe(
            "gap: mapped evidence shows a gap; conflict: assessed compliant against failing evidence; none: no checks mapped.",
          ),
        search: z.string().max(200).optional().describe("Matches clause number, title or text."),
        drafts_only: z.boolean().optional().describe("Only clauses with a drafted finding awaiting review."),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const id = await resolveStandard(api, slug, a.standard);
      return api.call(
        ws(api).governance.standards[":id"].$get({
          param: { slug, id },
          query: {
            ...(a.status ? { status: a.status } : {}),
            ...(a.section ? { section: a.section } : {}),
            ...(a.fundamental_only ? { fundamental: "true" as const } : {}),
            ...(a.search ? { q: a.search } : {}),
            ...(a.evidence ? { evidence: a.evidence } : {}),
            ...(a.drafts_only ? { drafts: "open" as const } : {}),
          },
        }),
      );
    },
  );

  define(
    "get_standard_clause",
    {
      module: "governance",
      resource: { name: "standard_clauses", op: "get" },
      title: "Get a clause and its assessment history",
      description:
        "One clause of a standard (id from get_gap_analysis) with its text and every assessment made of it, newest first: status, note, owner, due date, who assessed it and when.",
      annotations: READ,
      input: { workspace: workspaceParam, clause: z.uuid().describe("Clause id.") },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      return api.call(ws(api).governance.clauses[":id"].$get({ param: { slug, id: a.clause } }));
    },
  );

  define(
    "import_standard_clauses",
    {
      module: "governance",
      title: "Import a standard's clauses",
      description:
        "Import clauses into a standard from CSV with a header row: clause number and title (required), text, section, section title and fundamental (yes/no), in any order. Use only text the workspace is licensed to use. New clause numbers are added and existing ones take the new title and text; any error in the file changes nothing and is reported by line. `dry_run` checks without importing. Needs manage access to the governance module.",
      annotations: CREATE,
      input: {
        workspace: workspaceParam,
        standard: z.string().min(1).max(200).describe('Standard id, or code and issue, e.g. "BRCGS-FS 9".'),
        csv: z.string().min(1).max(3_000_000),
        dry_run: z.boolean().optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const id = await resolveStandard(api, slug, a.standard);
      return api.call(
        ws(api).governance.standards[":id"].clauses.import.$post({
          param: { slug, id },
          json: { csv: a.csv, dryRun: a.dry_run ?? false },
        }),
      );
    },
  );

  define(
    "list_evidence_checks",
    {
      module: "governance",
      resource: { name: "evidence_checks", op: "list" },
      title: "List automatic evidence checks",
      description:
        "Every automatic evidence check with its live result for you: met, gap (with the records behind it, e.g. which calibrations are overdue), no data, or unavailable (a module you can't read). Each lists what it looks at, its topics (to help map it to clauses) and the clauses it is mapped to. Checks: traceability test, internal audits, overdue corrective actions, HACCP plan review, CCP monitoring, cleaning, calibration, SOP reviews and acknowledgements, specification reviews, supplier controls, training, food defence, food fraud, management review and the requirement register. They see what is recorded, not practice on the floor.",
      annotations: READ,
      input: { workspace: workspaceParam },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      return api.call(ws(api).governance["evidence-checks"].$get({ param: { slug } }));
    },
  );

  define(
    "map_clause_evidence",
    {
      module: "governance",
      title: "Map evidence checks to a clause",
      description:
        "Set which automatic evidence checks support a clause (clause id from get_gap_analysis; check ids from list_evidence_checks), replacing its current mapping; an empty list removes them. The clause then shows each check's live result, and a clause assessed compliant whose evidence shows a gap is flagged as a conflict. Mapping is configuration (needs manage): it applies at once and never changes a clause's assessed status. Base it on the clause text and each check's topics, and tell the person what you mapped.",
      annotations: CREATE,
      input: {
        workspace: workspaceParam,
        clause: z.uuid().describe("Clause id."),
        checks: z.array(z.enum(evidenceCheckIds)).max(evidenceCheckIds.length),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      return api.call(
        ws(api).governance.clauses[":id"].evidence.$put({
          param: { slug, id: a.clause },
          json: { checkIds: a.checks },
        }),
      );
    },
  );

  define(
    "draft_clause_finding",
    {
      module: "governance",
      title: "Draft a finding on a clause for a person to review",
      description:
        "Propose an assessment of a clause (clause id from get_gap_analysis): compliant, partial, gap or not applicable, with the finding as it would read, what it is based on (the clause text, evidence check results, records or documents you looked at) and, for a gap or partial compliance, a suggested owner and date. It is only a proposal: the clause's status doesn't change until a person accepts it, as their own assessment, or dismisses it in the gap analysis. A new draft replaces the clause's open one. Base it on evidence, say what you couldn't check, and never draft compliant without evidence for it.",
      annotations: CREATE,
      input: {
        workspace: workspaceParam,
        clause: z.uuid().describe("Clause id."),
        status: z.enum(draftableStatuses),
        finding: z
          .string()
          .min(1)
          .max(4000)
          .describe("The proposed finding, as it would read on the assessment."),
        basis: z
          .string()
          .max(4000)
          .optional()
          .describe("What the proposal is based on, and anything you couldn't check."),
        owner: z.string().max(200).optional().describe("Suggested owner: member id, email or exact name."),
        due_on: z.iso.date().optional().describe("Suggested date to close a finding by."),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const ownerUserId = await resolveMember(api, slug, a.owner);
      return api.call(
        ws(api).governance.clauses[":id"].drafts.$post({
          param: { slug, id: a.clause },
          json: {
            status: a.status,
            note: a.finding,
            rationale: a.basis ?? "",
            ...(ownerUserId ? { ownerUserId } : {}),
            ...(a.due_on ? { dueOn: a.due_on } : {}),
          },
        }),
      );
    },
  );

  define(
    "list_gap_snapshots",
    {
      module: "governance",
      resource: { name: "gap_snapshots", op: "list" },
      title: "List a standard's pre-audit snapshots",
      description: "Frozen copies of a standard's gap analysis, newest first, with who took each and when.",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        standard: z.string().min(1).max(200).describe('Standard id, or code and issue, e.g. "BRCGS-FS 9".'),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const id = await resolveStandard(api, slug, a.standard);
      return api.call(ws(api).governance.standards[":id"].snapshots.$get({ param: { slug, id } }));
    },
  );

  define(
    "get_gap_snapshot",
    {
      module: "governance",
      resource: { name: "gap_snapshots", op: "get" },
      title: "Read a pre-audit snapshot",
      description:
        "A frozen gap analysis (snapshot id from list_gap_snapshots): its summary and clauses as they stood, and what has changed since (clauses whose status differs now, clauses added or removed). Evidence from modules you can't read is hidden.",
      annotations: READ,
      input: { workspace: workspaceParam, snapshot: z.uuid().describe("Snapshot id.") },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      return api.call(ws(api).governance.snapshots[":id"].$get({ param: { slug, id: a.snapshot } }));
    },
  );

  define(
    "take_gap_snapshot",
    {
      module: "governance",
      title: "Take a pre-audit snapshot",
      description:
        "Freeze a standard's gap analysis as it stands now (e.g. before an audit), with a name. Snapshots are never edited. Needs manage.",
      annotations: CREATE,
      input: {
        workspace: workspaceParam,
        standard: z.string().min(1).max(200).describe('Standard id, or code and issue, e.g. "BRCGS-FS 9".'),
        label: z.string().min(1).max(120).describe('e.g. "Pre-audit November 2026".'),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const id = await resolveStandard(api, slug, a.standard);
      return api.call(
        ws(api).governance.standards[":id"].snapshots.$post({
          param: { slug, id },
          json: { label: a.label },
        }),
      );
    },
  );

  define(
    "raise_clause_task",
    {
      module: "governance",
      requiresModules: ["tasks"],
      title: "Raise a task to close a clause finding",
      description:
        "Raise a task, linked to the clause, to close a gap or partial compliance a person recorded (clause id from get_gap_analysis). The task is titled with the standard and clause, and takes the finding's owner and due date unless others are given. Refused when the clause has no open finding.",
      annotations: CREATE,
      input: {
        workspace: workspaceParam,
        clause: z.uuid().describe("Clause id."),
        team: z.uuid().describe("Team id the task belongs to."),
        assignee: z.string().max(200).optional().describe("Member id, email or exact name."),
        due_date: z.iso.date().optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const assigneeId = await resolveMember(api, slug, a.assignee);
      return api.call(
        ws(api).governance.clauses[":id"].tasks.$post({
          param: { slug, id: a.clause },
          json: {
            teamId: a.team,
            ...(assigneeId ? { assigneeId } : {}),
            ...(a.due_date ? { dueDate: a.due_date } : {}),
          },
        }),
      );
    },
  );

  define(
    "list_governance_requirements",
    {
      module: "governance",
      resource: { name: "governance_requirements", op: "list" },
      title: "List legal and customer requirements",
      description:
        "The compliance and customer requirement register: source, reference, title, customer, owner, compliance status from the last review and when it is next due.",
      annotations: READ,
      input: { workspace: workspaceParam },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const { requirements } = await api.call(ws(api).governance.requirements.$get({ param: { slug } }));
      return {
        requirements: requirements.map((r) => ({
          id: r.id,
          source: r.source,
          reference: r.reference,
          title: r.title,
          customer: r.customerName,
          owner: r.ownerName,
          compliance: r.compliance,
          lastReviewedOn: r.lastReviewedOn,
          reviewDueOn: r.reviewDueOn,
          reviewStatus: r.reviewStatus,
          status: r.status,
        })),
        note: PERSON_NOTE,
      };
    },
  );

  define(
    "add_governance_requirement",
    {
      module: "governance",
      title: "Add legal or customer requirement",
      description:
        "Adds a requirement to the register: source (legal, customer, standard, certification, other), reference, title, customer, description, owner and first review date. Compliance is assessed by a person.",
      annotations: CREATE,
      input: {
        workspace: workspaceParam,
        source: z.enum(governanceRequirementSources),
        title: z.string().min(1).max(300),
        reference: z.string().max(200).optional(),
        customer: z.string().max(200).optional(),
        description: z.string().max(4000).optional(),
        owner: z.string().max(200).optional(),
        review_due_on: z.string().date().optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const r = await api.call(
        ws(api).governance.requirements.$post({
          param: { slug },
          json: {
            source: a.source,
            title: a.title,
            ...(a.reference ? { reference: a.reference } : {}),
            ...(a.customer ? { customerName: a.customer } : {}),
            ...(a.description ? { description: a.description } : {}),
            ...(a.owner ? { ownerUserId: await resolveMember(api, slug, a.owner) } : {}),
            ...(a.review_due_on ? { reviewDueOn: a.review_due_on } : {}),
          },
        }),
      );
      return {
        id: r.id,
        title: r.title,
        compliance: r.compliance,
        reviewDueOn: r.reviewDueOn,
        note: PERSON_NOTE,
      };
    },
  );

  const fetchReview = (api: Api, slug: string, id: string) =>
    api.call(ws(api).governance.reviews[":id"].$get({ param: { slug, id } }));
  type Review = Awaited<ReturnType<typeof fetchReview>>;
  const reviewView = (r: Review) => ({
    id: r.id,
    title: r.title,
    period: { from: r.periodFrom, to: r.periodTo },
    heldOn: r.heldOn,
    attendees: r.attendees,
    status: r.status,
    signedAt: r.signedAt,
    signedBy: r.signedByName,
    notes: r.notes,
    resources: r.resources,
    followUpTeam: r.followUpTeam?.name ?? null,
    decisions: r.decisions.map((d) => ({
      id: d.id,
      topic: d.topic,
      decision: d.decision,
      owner: d.ownerName,
      dueOn: d.dueOn,
      taskId: d.taskId ?? null,
    })),
    evidence: r.evidence,
    evidenceIsSnapshot: r.evidenceIsSnapshot,
    signBlockers: r.signBlockers,
    note: PERSON_NOTE,
  });

  define(
    "list_management_reviews",
    {
      module: "governance",
      resource: { name: "management_reviews", op: "list" },
      title: "List management reviews",
      description:
        "Management reviews with their period, when held, status (draft or signed) and number of decisions.",
      annotations: READ,
      input: { workspace: workspaceParam },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      return await api.call(ws(api).governance.reviews.$get({ param: { slug } }));
    },
  );

  define(
    "get_management_review",
    {
      module: "governance",
      resource: { name: "management_reviews", op: "get" },
      title: "Get management review",
      description:
        "One management review by id or exact title: notes per agenda topic, decisions with owners and follow-up tasks, and the evidence for the period from complaints, non-conformances, audits, incidents, testing, food defence, objectives, the culture plan, concern counts, requirements and actions from earlier reviews. A module the reader can't see is marked unavailable. A signed review shows the evidence as it was when signed.",
      annotations: READ,
      input: { workspace: workspaceParam, review: z.string().min(1).max(200) },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const { reviews } = await api.call(ws(api).governance.reviews.$get({ param: { slug } }));
      return reviewView(
        await fetchReview(api, slug, await resolveByTitle(reviews, a.review, "management review")),
      );
    },
  );

  define(
    "save_management_review",
    {
      module: "governance",
      title: "Save management review",
      description: `Creates a draft management review (give \`title\`, \`period_from\`, \`period_to\`) or updates a draft (give \`review\`): when held, attendees, notes per agenda topic (\`notes\` merges into the existing notes), resources, decisions and the follow-up team (by name). \`decisions\` replaces the whole list; keep an existing decision's \`id\`. Each decision with an owner becomes a task in the follow-up team when a person signs the review. ${PERSON_NOTE}`,
      annotations: CREATE,
      input: {
        workspace: workspaceParam,
        review: z.string().max(200).optional(),
        title: z.string().min(1).max(200).optional(),
        period_from: z.string().date().optional(),
        period_to: z.string().date().optional(),
        held_on: z.string().date().nullable().optional(),
        attendees: z.string().max(2000).nullable().optional(),
        notes: z.record(z.string().max(60), z.string().max(10_000)).optional(),
        resources: z.string().max(4000).nullable().optional(),
        decisions: z
          .array(
            z.object({
              id: z.string().uuid().optional(),
              topic: z.string().max(200).nullable().optional(),
              decision: z.string().min(1).max(2000),
              owner: z.string().max(200).nullable().optional(),
              due_on: z.string().date().nullable().optional(),
            }),
          )
          .max(100)
          .optional(),
        follow_up_team: z.string().max(200).nullable().optional().describe("Team id or exact name."),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      let id: string;
      let existing: Review | null = null;
      if (a.review) {
        const { reviews } = await api.call(ws(api).governance.reviews.$get({ param: { slug } }));
        id = await resolveByTitle(reviews, a.review, "management review");
        existing = await fetchReview(api, slug, id);
      } else {
        if (!a.title || !a.period_from || !a.period_to)
          throw new ToolError(
            "invalid_input",
            "Give `title`, `period_from` and `period_to` for a new review, or `review`.",
          );
        id = (
          await api.call(
            ws(api).governance.reviews.$post({
              param: { slug },
              json: { title: a.title, periodFrom: a.period_from, periodTo: a.period_to },
            }),
          )
        ).id;
      }
      let followUpTeamId: string | null | undefined;
      if (a.follow_up_team !== undefined) {
        if (a.follow_up_team === null || UUID.test(a.follow_up_team)) followUpTeamId = a.follow_up_team;
        else {
          const { teams } = await fetchBootstrap(api, slug);
          const match = teams.filter((t) => t.name.toLowerCase() === a.follow_up_team!.toLowerCase());
          if (match.length !== 1) throw new ToolError("not_found", `No team is named "${a.follow_up_team}".`);
          followUpTeamId = match[0]!.id;
        }
      }
      const decisions = a.decisions
        ? await Promise.all(
            a.decisions.map(async (d) => ({
              id: d.id ?? newId(),
              topic: d.topic ?? null,
              decision: d.decision,
              ownerUserId: (await resolveMember(api, slug, d.owner ?? null)) ?? null,
              dueOn: d.due_on ?? null,
            })),
          )
        : undefined;
      const patch = {
        ...(existing && a.title ? { title: a.title } : {}),
        ...(existing && a.period_from ? { periodFrom: a.period_from } : {}),
        ...(existing && a.period_to ? { periodTo: a.period_to } : {}),
        ...(a.held_on !== undefined ? { heldOn: a.held_on } : {}),
        ...(a.attendees !== undefined ? { attendees: a.attendees } : {}),
        ...(a.notes ? { notes: { ...(existing?.notes ?? {}), ...a.notes } } : {}),
        ...(a.resources !== undefined ? { resources: a.resources } : {}),
        ...(decisions ? { decisions } : {}),
        ...(followUpTeamId !== undefined ? { followUpTeamId } : {}),
      };
      if (!Object.keys(patch).length) return reviewView(existing ?? (await fetchReview(api, slug, id)));
      return reviewView(
        await api.call(ws(api).governance.reviews[":id"].$patch({ param: { slug, id }, json: patch })),
      );
    },
  );
}
