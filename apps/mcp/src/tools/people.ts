import { staffStatuses } from "@knotworking/core";
import { z } from "zod";
import { ToolError, type Api } from "../api";
import { importCsvBody, importCsvInput, importCsvView, type ToolContext } from "./shared";

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const CREATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
/** Replaces fields from a file; sending the same file again changes nothing. */
const REPLACE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
const UPDATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STAFF_NUMBER = /^\d{6}$/;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

/**
 * People module: the staff register and job roles. There are deliberately no PIN tools: setting,
 * clearing or unlocking a kiosk PIN is a manager's act in the app, and an agent never sees one.
 */
export function registerPeopleTools({ define, slugOf, workspaceParam }: ToolContext) {
  const ws = (api: Api) => api.client.v1.workspaces[":slug"];

  type Staff = Awaited<ReturnType<typeof getStaffById>>;
  const getStaffById = (api: Api, slug: string, id: string) =>
    api.call(ws(api).people.staff[":id"].$get({ param: { slug, id } }));

  /** A person by id or exact 6-digit staff number. */
  async function resolveStaff(api: Api, slug: string, ref: string): Promise<Staff> {
    const wanted = ref.trim();
    if (UUID.test(wanted)) return getStaffById(api, slug, wanted);
    if (STAFF_NUMBER.test(wanted)) {
      const { staff } = await api.call(
        ws(api).people.staff.$get({ param: { slug }, query: { q: wanted, status: "all", limit: "500" } }),
      );
      const match = staff.find((s) => s.staffNumber === wanted);
      if (match) return match;
    }
    throw new ToolError(
      "not_found",
      `No staff member has the id or staff number "${wanted}". Use list_staff to find them.`,
    );
  }

  /** Job roles by id or exact name (case-insensitive). */
  async function resolveJobRoles(api: Api, slug: string, refs: string[]) {
    const { jobRoles } = await api.call(
      ws(api).people["job-roles"].$get({ param: { slug }, query: { status: "all" } }),
    );
    return refs.map((ref) => {
      const wanted = ref.trim().toLowerCase();
      const match = jobRoles.find((r) => r.id === ref.trim() || r.name.toLowerCase() === wanted);
      if (!match) {
        throw new ToolError(
          "not_found",
          `No job role is called "${ref}". Use list_job_roles, or create_job_role first.`,
        );
      }
      return match.id;
    });
  }

  const staffView = (s: Staff) => ({
    id: s.id,
    staffNumber: s.staffNumber,
    name: `${s.firstName} ${s.lastName}`,
    firstName: s.firstName,
    lastName: s.lastName,
    status: s.status,
    jobTitle: s.jobTitle,
    department: s.department,
    jobRoles: s.jobRoles.map((r) => r.name),
    startDate: s.startDate,
    endDate: s.endDate,
    payrollReference: s.payrollReference,
    linkedMember: s.user ? { name: s.user.name, email: s.user.email } : null,
    hasKioskPin: s.hasPin,
  });

  const staffFields = {
    job_title: z.string().max(200).nullable().optional(),
    department: z.string().max(200).nullable().optional(),
    start_date: isoDate.nullable().optional().describe("First day of employment, YYYY-MM-DD."),
    payroll_reference: z
      .string()
      .max(60)
      .nullable()
      .optional()
      .describe("Employee number in the payroll package, if it differs from the staff number."),
    job_roles: z
      .array(z.string().min(1).max(120))
      .max(50)
      .optional()
      .describe("Job role names or ids; replaces the person's roles."),
  };
  type StaffFieldArgs = z.infer<z.ZodObject<typeof staffFields>>;
  const staffBody = async (api: Api, slug: string, a: StaffFieldArgs) => ({
    ...(a.job_title !== undefined ? { jobTitle: a.job_title } : {}),
    ...(a.department !== undefined ? { department: a.department } : {}),
    ...(a.start_date !== undefined ? { startDate: a.start_date } : {}),
    ...(a.payroll_reference !== undefined ? { payrollReference: a.payroll_reference } : {}),
    ...(a.job_roles !== undefined ? { jobRoleIds: await resolveJobRoles(api, slug, a.job_roles) } : {}),
  });

  define(
    "list_staff",
    {
      module: "people",
      resource: { name: "staff", op: "list" },
      title: "List staff",
      description:
        'List people in the staff register (most have no login): staff number, name, job title, department, job roles and status. `query` matches name, staff number, payroll reference, job title or department. Default: active staff only; `status: "all"` includes leavers. Paged: use `offset` while `hasMore` is true.',
      annotations: READ,
      input: {
        workspace: workspaceParam,
        query: z.string().max(200).optional(),
        job_role: z.string().max(120).optional().describe("Only people holding this job role (name or id)."),
        department: z.string().max(200).optional(),
        status: z.enum([...staffStatuses, "all"]).optional(),
        limit: z.number().int().min(1).max(500).optional().describe("Maximum people (default 100, max 500)."),
        offset: z.number().int().min(0).optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const jobRoleId = a.job_role ? (await resolveJobRoles(api, slug, [a.job_role]))[0] : undefined;
      const page = await api.call(
        ws(api).people.staff.$get({
          param: { slug },
          query: {
            ...(a.query ? { q: a.query } : {}),
            ...(jobRoleId ? { jobRoleId } : {}),
            ...(a.department ? { department: a.department } : {}),
            ...(a.status ? { status: a.status } : {}),
            limit: String(a.limit ?? 100),
            offset: String(a.offset ?? 0),
          },
        }),
      );
      return {
        staff: page.staff.map(staffView),
        total: page.total,
        offset: page.offset,
        returned: page.staff.length,
        hasMore: page.offset + page.staff.length < page.total,
      };
    },
  );

  define(
    "create_staff",
    {
      module: "people",
      title: "Add a staff member",
      description:
        "Add a person to the staff register. Without `staff_number` the next free 6-digit number is used. Numbers are never reused, so check list_staff before adding someone who may already be there (leavers included). A kiosk PIN can only be set by a manager in the app.",
      annotations: CREATE,
      input: {
        workspace: workspaceParam,
        first_name: z.string().min(1).max(100),
        last_name: z.string().min(1).max(100),
        staff_number: z.string().regex(STAFF_NUMBER, "Exactly 6 digits").optional(),
        ...staffFields,
      },
    },
    async ({ workspace, first_name, last_name, staff_number, ...rest }, api) => {
      const slug = await slugOf(api, workspace);
      const body = await staffBody(api, slug, rest);
      return staffView(
        await api.call(
          ws(api).people.staff.$post({
            param: { slug },
            json: {
              firstName: first_name,
              lastName: last_name,
              ...(staff_number ? { staffNumber: staff_number } : {}),
              ...body,
            },
          }),
        ),
      );
    },
  );

  define(
    "update_staff",
    {
      module: "people",
      title: "Update a staff member",
      description:
        'Change a person\'s details or job roles, or record that they have left (`status: "leaver"`, with `end_date` as their last day; default today). Identify them by id or staff number. Only the fields you pass change.',
      annotations: UPDATE,
      input: {
        workspace: workspaceParam,
        staff: z.string().min(1).max(60).describe("Staff id or 6-digit staff number."),
        first_name: z.string().min(1).max(100).optional(),
        last_name: z.string().min(1).max(100).optional(),
        status: z.enum(staffStatuses).optional(),
        end_date: isoDate.nullable().optional().describe("Last day of employment, YYYY-MM-DD."),
        ...staffFields,
      },
    },
    async ({ workspace, staff, first_name, last_name, status, end_date, ...rest }, api) => {
      const slug = await slugOf(api, workspace);
      const person = await resolveStaff(api, slug, staff);
      const json = {
        ...(first_name !== undefined ? { firstName: first_name } : {}),
        ...(last_name !== undefined ? { lastName: last_name } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(end_date !== undefined ? { endDate: end_date } : {}),
        ...(await staffBody(api, slug, rest)),
      };
      if (Object.keys(json).length === 0) throw new ToolError("invalid_input", "Nothing to update");
      return staffView(
        await api.call(ws(api).people.staff[":id"].$patch({ param: { slug, id: person.id }, json })),
      );
    },
  );

  define(
    "list_job_roles",
    {
      module: "people",
      resource: { name: "job_roles", op: "list" },
      title: "List job roles",
      description: "Job roles (line operative, hygiene, first aider) with how many active staff hold each.",
      annotations: READ,
      input: { workspace: workspaceParam, include_archived: z.boolean().optional() },
    },
    async ({ workspace, include_archived }, api) => {
      const slug = await slugOf(api, workspace);
      const { jobRoles } = await api.call(
        ws(api).people["job-roles"].$get({
          param: { slug },
          query: { status: include_archived ? "all" : "active" },
        }),
      );
      return {
        jobRoles: jobRoles.map((r) => ({
          id: r.id,
          name: r.name,
          description: r.description,
          status: r.status,
          staffCount: r.staffCount,
        })),
      };
    },
  );

  define(
    "create_job_role",
    {
      module: "people",
      title: "Create a job role",
      description: "Add a job role. Names are unique in the workspace (case-insensitive).",
      annotations: CREATE,
      input: {
        workspace: workspaceParam,
        name: z.string().min(1).max(120),
        description: z.string().max(2000).optional(),
      },
    },
    async ({ workspace, name, description }, api) => {
      const slug = await slugOf(api, workspace);
      const role = await api.call(
        ws(api).people["job-roles"].$post({
          param: { slug },
          json: { name, ...(description ? { description } : {}) },
        }),
      );
      return { id: role.id, name: role.name, description: role.description, status: role.status };
    },
  );

  define(
    "import_staff_csv",
    {
      module: "people",
      title: "Import staff from CSV",
      description:
        "Create and update staff from CSV text with a header row. Rows are matched by staff number (exactly 6 digits, kept as text; a number is never changed or reused). Columns (any order): staff number (required); first name and last name (needed for new people), job title, department, job roles (existing role names separated by `;`; the cell replaces the person's roles, empty means none), start date, end date (YYYY-MM-DD or DD/MM/YYYY), payroll reference, status (active, leaver). A missing column leaves existing people alone; an empty cell clears the value except names and status. Kiosk PINs and login links can't be imported (a PIN column is ignored and reported). Use `dry_run: true` first to check every row and preview; a real import writes every row in one go, or nothing if any row has a problem. Up to 5000 rows.",
      annotations: REPLACE,
      input: { workspace: workspaceParam, ...importCsvInput },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      return importCsvView(
        await api.call(ws(api).people.staff.import.$post({ param: { slug }, json: importCsvBody(a) })),
      );
    },
  );
}
