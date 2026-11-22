import { defenceControlKinds, defenceReviewTriggers, defenceThreatSources, newId } from "@knotworking/core";
import { z } from "zod";
import { ToolError, type Api } from "../api";
import type { ToolContext } from "./shared";

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const CREATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERSON_NOTE =
  "Approving an assessment, recording a security check, resolving a failed check and recording an exercise are done by people in the Knotworking app; there are no tools for them.";

const threatInput = z.object({
  id: z
    .string()
    .uuid()
    .optional()
    .describe("Keep an existing threat's id when editing it; leave out for a new one."),
  area: z.string().min(1).max(200).describe("Where: an area, process step or material."),
  threat: z.string().min(1).max(2000).describe("What could happen and how."),
  source: z.enum(defenceThreatSources),
  likelihood: z.number().int().min(1).max(5),
  impact: z.number().int().min(1).max(5),
  existing_controls: z.string().max(2000).nullable().optional(),
  mitigation: z
    .string()
    .max(2000)
    .nullable()
    .optional()
    .describe("Required when likelihood × impact is 15 or more."),
  controls: z.array(z.string().max(200)).max(20).optional().describe("Security control ids or exact names."),
});

/** Food defence: threat assessments and security controls. Agents may draft; people approve and check. */
export function registerDefenceTools({ define, slugOf, workspaceParam }: ToolContext) {
  const ws = (api: Api) => api.client.v1.workspaces[":slug"];

  const fetchControls = async (api: Api, slug: string) =>
    (await api.call(ws(api).defence.controls.$get({ param: { slug }, query: { status: "all" } }))).controls;

  async function resolveAssessmentId(api: Api, slug: string, ref: string) {
    const wanted = ref.trim();
    if (UUID.test(wanted)) return wanted;
    const { assessments } = await api.call(ws(api).defence.assessments.$get({ param: { slug } }));
    const match = assessments.filter((a) => a.title.toLowerCase() === wanted.toLowerCase());
    if (match.length === 1) return match[0]!.id;
    throw new ToolError("not_found", `No assessment is titled "${wanted}". Use list_defence_assessments.`);
  }

  const fetchAssessment = (api: Api, slug: string, id: string) =>
    api.call(ws(api).defence.assessments[":id"].$get({ param: { slug, id } }));
  type Assessment = Awaited<ReturnType<typeof fetchAssessment>>;
  type Version = NonNullable<Assessment["approved"]>;
  const versionView = (v: Version, controlName: (id: string) => string) => ({
    version: v.versionNumber,
    status: v.status,
    summary: v.summary,
    reviewDueOn: v.reviewDueOn,
    reviewTrigger: v.reviewTrigger,
    reviewReason: v.reviewReason,
    approvedAt: v.approvedAt,
    approvedBy: v.approvedByName,
    threats: v.threats.map((t) => ({
      id: t.id,
      area: t.area,
      threat: t.threat,
      source: t.source,
      likelihood: t.likelihood,
      impact: t.impact,
      score: t.score,
      rating: t.rating,
      existingControls: t.existingControls,
      mitigation: t.mitigation,
      controls: t.controlIds.map(controlName),
    })),
  });
  const view = (a: Assessment) => {
    const name = (id: string) => a.controls.find((c) => c.id === id)?.name ?? id;
    return {
      id: a.id,
      title: a.title,
      scope: a.scope,
      status: a.status,
      reviewStatus: a.reviewStatus,
      approved: a.approved ? versionView(a.approved, name) : null,
      draft: a.draft ? versionView(a.draft, name) : null,
      draftChanges: a.draftChanges,
      approvalBlockers: a.approvalBlockers,
      history: a.history.map((v) => ({
        version: v.versionNumber,
        status: v.status,
        approvedAt: v.approvedAt,
      })),
      exercises: a.exercises,
      note: PERSON_NOTE,
    };
  };

  async function toThreats(api: Api, slug: string, threats: z.infer<typeof threatInput>[]) {
    const controls = threats.some((t) => t.controls?.length) ? await fetchControls(api, slug) : [];
    const controlId = (ref: string) => {
      if (UUID.test(ref)) return ref;
      const match = controls.filter((c) => c.name.toLowerCase() === ref.trim().toLowerCase());
      if (match.length === 1) return match[0]!.id;
      throw new ToolError("not_found", `No security control is named "${ref}". Use list_defence_controls.`);
    };
    return threats.map((t) => ({
      id: t.id ?? newId(),
      area: t.area,
      threat: t.threat,
      source: t.source,
      likelihood: t.likelihood,
      impact: t.impact,
      existingControls: t.existing_controls ?? null,
      mitigation: t.mitigation ?? null,
      controlIds: (t.controls ?? []).map(controlId),
    }));
  }

  define(
    "get_food_defence_overview",
    {
      module: "defence",
      title: "Get food defence overview",
      description:
        "What needs attention in food defence: security controls overdue or never checked, failed checks not yet resolved, assessments due for review or never approved, the last exercise and when the next is due, and (with Attendance access) visitors signed in now.",
      annotations: READ,
      input: { workspace: workspaceParam },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const o = await api.call(ws(api).defence.overview.$get({ param: { slug } }));
      return {
        counts: o.counts,
        controlsDue: o.controlsDue.map((c) => ({
          name: c.name,
          kind: c.kind,
          area: c.area,
          status: c.dueStatus,
          dueOn: c.dueOn,
          lastCheckedOn: c.lastCheckedOn,
        })),
        openFailures: o.openFailures.map((f) => ({
          control: f.controlName,
          checkedOn: f.checkedOn,
          notes: f.notes,
          actionTaken: f.actionTaken,
        })),
        assessmentsDue: o.assessmentsDue.map((x) => ({
          title: x.title,
          status: x.reviewStatus,
          reviewDueOn: x.reviewDueOn,
          approvedVersion: x.approvedVersion,
        })),
        lastExercise: o.lastExercise,
        exerciseDueOn: o.exerciseDueOn,
        visitorsOnSite: o.visitors?.onSite ?? null,
      };
    },
  );

  define(
    "list_defence_assessments",
    {
      module: "defence",
      resource: { name: "defence_assessments", op: "list" },
      title: "List food defence assessments",
      description:
        "Threat assessments with the approved version, its review date and status, how many threats rate high, and whether a review draft is in progress.",
      annotations: READ,
      input: { workspace: workspaceParam },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const { assessments } = await api.call(ws(api).defence.assessments.$get({ param: { slug } }));
      return {
        assessments: assessments.map((x) => ({
          id: x.id,
          title: x.title,
          status: x.status,
          approvedVersion: x.approvedVersion,
          reviewDueOn: x.reviewDueOn,
          reviewStatus: x.reviewStatus,
          threats: x.threatCount,
          highThreats: x.highThreats,
          draftVersion: x.draftVersion,
        })),
      };
    },
  );

  define(
    "get_defence_assessment",
    {
      module: "defence",
      resource: { name: "defence_assessments", op: "get" },
      title: "Get food defence assessment",
      description:
        "One assessment by id or exact title: the approved version's threats with likelihood, impact, score and rating, controls and mitigations; the review draft if one is open, what it changes and why it can't be approved yet; the version history; and exercises that tested it.",
      annotations: READ,
      input: { workspace: workspaceParam, assessment: z.string().min(1).max(200) },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      return view(await fetchAssessment(api, slug, await resolveAssessmentId(api, slug, a.assessment)));
    },
  );

  define(
    "draft_defence_assessment",
    {
      module: "defence",
      title: "Draft food defence assessment",
      description: `Creates an assessment (give \`title\`) with a first draft, or saves the open draft of one (give \`assessment\`). \`threats\` replaces the draft's whole list, so pass every threat to keep, with its \`id\`. An approved assessment has no draft until a review is started (start_defence_review). ${PERSON_NOTE}`,
      annotations: CREATE,
      input: {
        workspace: workspaceParam,
        assessment: z.string().max(200).optional().describe("An existing assessment's id or title."),
        title: z.string().min(1).max(200).optional(),
        scope: z.string().max(2000).nullable().optional(),
        summary: z.string().max(4000).nullable().optional(),
        threats: z.array(threatInput).max(200).optional(),
        review_due_on: z.string().date().nullable().optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const threats = a.threats ? await toThreats(api, slug, a.threats) : undefined;
      const draft = {
        ...(a.summary !== undefined ? { summary: a.summary } : {}),
        ...(threats ? { threats } : {}),
        ...(a.review_due_on !== undefined ? { reviewDueOn: a.review_due_on } : {}),
      };
      if (a.assessment) {
        const id = await resolveAssessmentId(api, slug, a.assessment);
        if (a.title || a.scope !== undefined)
          await api.call(
            ws(api).defence.assessments[":id"].$patch({
              param: { slug, id },
              json: {
                ...(a.title ? { title: a.title } : {}),
                ...(a.scope !== undefined ? { scope: a.scope } : {}),
              },
            }),
          );
        if (!Object.keys(draft).length) return view(await fetchAssessment(api, slug, id));
        return view(
          await api.call(ws(api).defence.assessments[":id"].draft.$put({ param: { slug, id }, json: draft })),
        );
      }
      if (!a.title)
        throw new ToolError(
          "invalid_input",
          "Give `title` for a new assessment, or `assessment` to edit one.",
        );
      return view(
        await api.call(
          ws(api).defence.assessments.$post({
            param: { slug },
            json: {
              title: a.title,
              ...(a.scope !== undefined ? { scope: a.scope } : {}),
              draft: { threats: threats ?? [], ...draft },
            },
          }),
        ),
      );
    },
  );

  define(
    "start_defence_review",
    {
      module: "defence",
      title: "Start food defence assessment review",
      description:
        "Opens a review of an approved assessment: a new draft copied from the approved version, which stays in force (and is kept once the review is approved). Give the trigger (scheduled, incident, site_change, intelligence, exercise, other) and a reason.",
      annotations: CREATE,
      input: {
        workspace: workspaceParam,
        assessment: z.string().min(1).max(200),
        trigger: z.enum(defenceReviewTriggers),
        reason: z.string().max(2000).optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const id = await resolveAssessmentId(api, slug, a.assessment);
      return view(
        await api.call(
          ws(api).defence.assessments[":id"].review.$post({
            param: { slug, id },
            json: { trigger: a.trigger, ...(a.reason ? { reason: a.reason } : {}) },
          }),
        ),
      );
    },
  );

  define(
    "list_defence_controls",
    {
      module: "defence",
      resource: { name: "defence_controls", op: "list" },
      title: "List security controls",
      description:
        "Food defence security controls (access, perimeter, keys, CCTV, tamper evidence…) with how often each is checked, the last check, when it is next due (overdue, due_soon, never, ok) and open failures.",
      annotations: READ,
      input: { workspace: workspaceParam, include_archived: z.boolean().optional() },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const { controls } = await api.call(
        ws(api).defence.controls.$get({
          param: { slug },
          query: { status: a.include_archived ? "all" : "active" },
        }),
      );
      return {
        controls: controls.map((c) => ({
          id: c.id,
          name: c.name,
          kind: c.kind,
          area: c.area,
          frequencyDays: c.frequencyDays,
          status: c.status,
          lastCheckedOn: c.lastCheckedOn,
          dueOn: c.dueOn,
          dueStatus: c.dueStatus,
          openFailures: c.openFailures,
        })),
        note: PERSON_NOTE,
      };
    },
  );

  define(
    "add_defence_control",
    {
      module: "defence",
      title: "Add security control",
      description:
        "Adds a food defence security control to the check schedule: a name, kind, the area and how often it is checked (days), and what the person checking looks for.",
      annotations: CREATE,
      input: {
        workspace: workspaceParam,
        name: z.string().min(1).max(200),
        kind: z.enum(defenceControlKinds),
        area: z.string().max(200).optional(),
        frequency_days: z.number().int().min(1).max(730),
        instructions: z.string().max(4000).optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const c = await api.call(
        ws(api).defence.controls.$post({
          param: { slug },
          json: {
            name: a.name,
            kind: a.kind,
            frequencyDays: a.frequency_days,
            ...(a.area ? { area: a.area } : {}),
            ...(a.instructions ? { instructions: a.instructions } : {}),
          },
        }),
      );
      return { id: c.id, name: c.name, kind: c.kind, frequencyDays: c.frequencyDays, note: PERSON_NOTE };
    },
  );
}
