import { trainingCourseKinds, trainingOutcomes, trainingStatuses } from "@knotworking/core";
import { z } from "zod";
import { ToolError, type Api } from "../api";
import type { ToolContext } from "./shared";

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const CREATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STAFF_NUMBER = /^\d{6}$/;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

const STATUS_HELP =
  "Statuses: current, expiring (within 30 days), expired, outdated (trained on an SOP version that has been replaced), pending_sign_off (trained, waiting for a manager's competency sign-off), missing (required by the person's job role, never trained; `overdue` once past its due date).";

/**
 * Training module. Agents can read where everyone stands and record who was trained (unsigned).
 * The competency sign-off and voiding a record are a manager's acts in the app: no tools.
 */
export function registerTrainingTools({ define, slugOf, workspaceParam }: ToolContext) {
  const ws = (api: Api) => api.client.v1.workspaces[":slug"];

  const listCourses = (api: Api, slug: string, status: "active" | "all" = "active") =>
    api.call(ws(api).training.courses.$get({ param: { slug }, query: { status } }));

  /** A course by id or exact code (case-insensitive). */
  async function resolveCourse(api: Api, slug: string, ref: string) {
    const wanted = ref.trim();
    const { courses } = await listCourses(api, slug, "all");
    const match = courses.find((c) => c.id === wanted || c.code.toLowerCase() === wanted.toLowerCase());
    if (match) return match;
    throw new ToolError("not_found", `No course has the id or code "${wanted}". Use list_training_courses.`);
  }

  /** A person by id or exact 6-digit staff number. */
  async function resolveStaffId(api: Api, slug: string, ref: string) {
    const wanted = ref.trim();
    if (UUID.test(wanted)) return wanted;
    if (STAFF_NUMBER.test(wanted)) {
      const { staff } = await api.call(
        ws(api).people.staff.$get({ param: { slug }, query: { q: wanted, status: "all", limit: "500" } }),
      );
      const match = staff.find((s) => s.staffNumber === wanted);
      if (match) return match.id;
    }
    throw new ToolError(
      "not_found",
      `No staff member has the id or staff number "${wanted}". Use list_staff.`,
    );
  }

  const jobRoleId = async (api: Api, slug: string, ref: string | undefined) => {
    if (!ref) return undefined;
    const { jobRoles } = await api.call(
      ws(api).people["job-roles"].$get({ param: { slug }, query: { status: "all" } }),
    );
    const match = jobRoles.find(
      (r) => r.id === ref.trim() || r.name.toLowerCase() === ref.trim().toLowerCase(),
    );
    if (!match) throw new ToolError("not_found", `No job role is called "${ref}". Use list_job_roles.`);
    return match.id;
  };

  const name = (s: { firstName: string; lastName: string }) => `${s.firstName} ${s.lastName}`;

  define(
    "list_training_courses",
    {
      module: "training",
      resource: { name: "training_courses", op: "list" },
      title: "List training courses",
      description:
        "Training courses with their kind (SOP, induction, on the job, external, certificate), how long training stays valid, whether a competency sign-off is needed, and which job roles need them.",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        include_archived: z.boolean().optional(),
        kind: z.enum(trainingCourseKinds).optional(),
      },
    },
    async ({ workspace, include_archived, kind }, api) => {
      const slug = await slugOf(api, workspace);
      const { courses } = await listCourses(api, slug, include_archived ? "all" : "active");
      return {
        courses: courses
          .filter((c) => !kind || c.kind === kind)
          .map((c) => ({
            id: c.id,
            code: c.code,
            title: c.title,
            kind: c.kind,
            status: c.status,
            validityMonths: c.validityMonths,
            requiresSignOff: c.requiresSignOff,
            sop: c.sop
              ? { code: c.sop.code, title: c.sop.title, currentVersion: c.sop.currentVersion }
              : null,
            requiredBy: c.requirements.map((r) => ({
              jobRole: r.jobRoleName,
              dueWithinDays: r.dueWithinDays,
            })),
          })),
      };
    },
  );

  define(
    "get_training_matrix",
    {
      module: "training",
      title: "Training matrix",
      description: `Where every active member of staff stands on each course that concerns them (required by their job roles or trained on), with a count per status. Filter by job_role, department, course or status. ${STATUS_HELP}`,
      annotations: READ,
      input: {
        workspace: workspaceParam,
        job_role: z.string().max(120).optional().describe("Job role name or id."),
        department: z.string().max(200).optional(),
        course: z.string().max(60).optional().describe("Course id or code: one column only."),
        status: z
          .enum(trainingStatuses)
          .optional()
          .describe("Only people with at least one course in this status."),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const [roleId, courseId] = await Promise.all([
        jobRoleId(api, slug, a.job_role),
        a.course ? resolveCourse(api, slug, a.course).then((c) => c.id) : undefined,
      ]);
      const matrix = await api.call(
        ws(api).training.matrix.$get({
          param: { slug },
          query: {
            ...(roleId ? { jobRoleId: roleId } : {}),
            ...(a.department ? { department: a.department } : {}),
            ...(courseId ? { courseId } : {}),
            ...(a.status ? { status: a.status } : {}),
          },
        }),
      );
      const codeOf = new Map(matrix.courses.map((c) => [c.id, c.code]));
      return {
        today: matrix.today,
        summary: matrix.summary,
        courses: matrix.courses.map((c) => ({ code: c.code, title: c.title })),
        staff: matrix.rows.map((r) => ({
          staffNumber: r.staff.staffNumber,
          name: name(r.staff),
          department: r.staff.department,
          jobRoles: r.staff.jobRoles.map((j) => j.name),
          courses: Object.entries(r.cells).map(([id, cell]) => ({ course: codeOf.get(id) ?? id, ...cell })),
        })),
      };
    },
  );

  define(
    "list_training_due",
    {
      module: "training",
      title: "Training due",
      description: `What needs doing, most urgent first: missing training (overdue first), expired, outdated, awaiting sign-off, and training expiring within within_days (default 30). ${STATUS_HELP}`,
      annotations: READ,
      input: {
        workspace: workspaceParam,
        within_days: z.number().int().min(0).max(365).optional(),
        job_role: z.string().max(120).optional(),
        department: z.string().max(200).optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const roleId = await jobRoleId(api, slug, a.job_role);
      const due = await api.call(
        ws(api).training.due.$get({
          param: { slug },
          query: {
            ...(a.within_days !== undefined ? { withinDays: String(a.within_days) } : {}),
            ...(roleId ? { jobRoleId: roleId } : {}),
            ...(a.department ? { department: a.department } : {}),
          },
        }),
      );
      return {
        today: due.today,
        items: due.items.map((i) => ({
          staffNumber: i.staff.staffNumber,
          name: name(i.staff),
          course: i.course.code,
          courseTitle: i.course.title,
          status: i.status,
          dueOn: i.dueOn,
          overdue: i.overdue,
          lastTrained: i.completedOn,
        })),
      };
    },
  );

  define(
    "get_staff_training",
    {
      module: "training",
      title: "A person's training",
      description: `One person's standing on every course that concerns them and their full training history, voided records included (marked). Identify them by id or staff number. ${STATUS_HELP}`,
      annotations: READ,
      input: {
        workspace: workspaceParam,
        staff: z.string().min(1).max(60).describe("Staff id or 6-digit staff number."),
      },
    },
    async ({ workspace, staff }, api) => {
      const slug = await slugOf(api, workspace);
      const staffId = await resolveStaffId(api, slug, staff);
      const t = await api.call(ws(api).training.staff[":staffId"].$get({ param: { slug, staffId } }));
      return {
        staffNumber: t.staff.staffNumber,
        name: name(t.staff),
        status: t.staff.status,
        jobRoles: t.staff.jobRoles.map((r) => r.name),
        standings: t.standings.map(({ course, ...cell }) => ({
          course: course.code,
          title: course.title,
          ...cell,
        })),
        records: t.records.map((r) => ({
          id: r.id,
          course: r.course.code,
          completedOn: r.completedOn,
          outcome: r.outcome,
          expiresOn: r.expiresOn,
          sopVersion: r.sopVersionNumber,
          trainer: r.trainer,
          signedOff: r.signedOffAt ? { by: r.signedOffByName, at: r.signedOffAt } : null,
          voided: r.voidedAt ? { by: r.voidedByName, at: r.voidedAt, reason: r.voidReason } : null,
        })),
      };
    },
  );

  define(
    "record_training",
    {
      module: "training",
      title: "Record training",
      description:
        "Record that one or more people completed a course on a date (one session, e.g. from an attendance sheet). For courses that need a competency sign-off the records wait for a manager to sign each person off in the app; agents can't sign off. SOP courses are recorded against the SOP's current approved version.",
      annotations: CREATE,
      input: {
        workspace: workspaceParam,
        course: z.string().min(1).max(60).describe("Course id or code."),
        staff: z
          .array(z.string().min(1).max(60))
          .min(1)
          .max(200)
          .describe("Staff ids or 6-digit staff numbers."),
        completed_on: isoDate.describe("The day of the training, YYYY-MM-DD (not in the future)."),
        outcome: z.enum(trainingOutcomes).optional().describe("Default competent."),
        trainer: z.string().max(200).optional().describe("Who gave the training (a name or provider)."),
        notes: z.string().max(4000).optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const [course, staffIds] = await Promise.all([
        resolveCourse(api, slug, a.course),
        Promise.all(a.staff.map((s) => resolveStaffId(api, slug, s))),
      ]);
      if (new Set(staffIds).size !== staffIds.length)
        throw new ToolError("invalid_input", "The same person is listed twice");
      const { records } = await api.call(
        ws(api).training.records.$post({
          param: { slug },
          json: {
            courseId: course.id,
            staffIds,
            completedOn: a.completed_on,
            ...(a.outcome ? { outcome: a.outcome } : {}),
            ...(a.trainer ? { trainerName: a.trainer } : {}),
            ...(a.notes ? { notes: a.notes } : {}),
          },
        }),
      );
      return {
        course: course.code,
        recorded: records.map((r) => ({
          id: r.id,
          staffNumber: r.staff.staffNumber,
          name: name(r.staff),
          expiresOn: r.expiresOn,
        })),
        awaitingSignOff: course.requiresSignOff && (a.outcome ?? "competent") === "competent",
      };
    },
  );
}
