import {
  jobCardExceptionKinds,
  jobCardStatuses,
  routingOperationInputSchema,
  unitCodes,
  workCentreCreateSchema,
  workCentreUpdateSchema,
} from "@knotworking/core";
import { z } from "zod";
import { ToolError, type Api } from "../api";
import { CREATE, READ, type ToolContext } from "./shared";

const WORK_CENTRE_FIELDS =
  "code (unique), name, description, hoursPerDay (0-24, per station), stations (how many work at once), costPerHour (labour and machine, workspace currency), notes, status (active or archived; changing only)";

const operationInput = z
  .array(
    z.object({
      name: z.string().min(1).max(200),
      work_centre_id: z.uuid(),
      setup_minutes: z.number().min(0).optional(),
      run_minutes: z.number().min(0).optional().describe("Minutes to run one batch of the bill's yield."),
      instructions: z.string().max(4000).optional(),
    }),
  )
  .max(50)
  .describe("The operations in order: the first is done first.");

type OperationArg = z.infer<typeof operationInput>[number];
function operations(list: OperationArg[]) {
  return list.map((op, index) => {
    const parsed = routingOperationInputSchema.safeParse({
      name: op.name,
      workCentreId: op.work_centre_id,
      setupMinutes: op.setup_minutes ?? 0,
      runMinutes: op.run_minutes ?? 0,
      instructions: op.instructions ?? null,
    });
    if (!parsed.success) {
      throw new ToolError(
        "invalid_input",
        `operations[${index}]: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      );
    }
    return parsed.data;
  });
}

/**
 * Routings module (`routings`): work centres, routings (the ordered operations that make a bill of
 * materials) and job cards per operation of a production batch. Agents keep work centres, draft
 * routings, make job cards and record work on them (time, good and scrap, exceptions, completion).
 * Approving a routing and voiding recorded work are a person's acts in the app.
 */
export function registerRoutingTools({ define, slugOf, workspaceParam }: ToolContext) {
  const ws = (api: Api) => api.client.v1.workspaces[":slug"];

  define(
    "list_work_centres",
    {
      module: "routings",
      resource: { name: "work_centres", op: "list" },
      title: "List work centres",
      description:
        "Work centres (cells, machines, benches) with code, capacity (hours a day, stations) and cost per hour. Filter by `status` (active by default, archived or all) and `q` (code or name).",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        q: z.string().max(200).optional(),
        status: z.enum(["active", "archived", "all"]).optional(),
      },
    },
    async ({ workspace, q, status }, api) => {
      const slug = await slugOf(api, workspace);
      return api.call(
        ws(api).routings["work-centres"].$get({
          param: { slug },
          query: { ...(q ? { q } : {}), ...(status ? { status } : {}) },
        }),
      );
    },
  );

  define(
    "save_work_centre",
    {
      module: "routings",
      title: "Add or change a work centre",
      description: `Add a work centre, or with \`id\` change one. Fields of \`work_centre\`: ${WORK_CENTRE_FIELDS}. Check list_work_centres first so you don't add a duplicate code.`,
      annotations: CREATE,
      input: {
        workspace: workspaceParam,
        id: z.uuid().optional().describe("Id of the work centre to change; omit to add one."),
        work_centre: z.record(z.string(), z.unknown()).describe("The fields to set (see the description)."),
      },
    },
    async ({ workspace, id, work_centre }, api) => {
      const slug = await slugOf(api, workspace);
      const parsed = (id ? workCentreUpdateSchema : workCentreCreateSchema).safeParse(work_centre);
      if (!parsed.success) {
        throw new ToolError(
          "invalid_input",
          `work_centre: ${parsed.error.issues.map((i) => `${i.path.join(".") || "work_centre"}: ${i.message}`).join("; ")}. Fields: ${WORK_CENTRE_FIELDS}.`,
        );
      }
      const json = parsed.data as never;
      const saved = id
        ? await api.call(ws(api).routings["work-centres"][":id"].$patch({ param: { slug, id }, json }))
        : await api.call(ws(api).routings["work-centres"].$post({ param: { slug }, json }));
      return { created: !id, ...saved };
    },
  );

  define(
    "list_routings",
    {
      module: "routings",
      resource: { name: "routings", op: "list" },
      title: "List routings",
      description:
        "Routings: for each bill of materials, its approved version (and number of operations) and any draft. Filter by `bom_id`, `status` (active by default, archived or all) and `q` (routing or bill code or name). Paged with `limit` and `offset`.",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        q: z.string().max(200).optional(),
        bom_id: z.uuid().optional().describe("The bill of materials (recipe) id."),
        status: z.enum(["active", "archived", "all"]).optional(),
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
      },
    },
    async ({ workspace, q, bom_id, status, limit, offset }, api) => {
      const slug = await slugOf(api, workspace);
      const page = await api.call(
        ws(api).routings.$get({
          param: { slug },
          query: {
            ...(q ? { q } : {}),
            ...(bom_id ? { recipeId: bom_id } : {}),
            ...(status ? { status } : {}),
            ...(limit !== undefined ? { limit: String(limit) } : {}),
            ...(offset !== undefined ? { offset: String(offset) } : {}),
          },
        }),
      );
      return { ...page, hasMore: page.offset + page.routings.length < page.total };
    },
  );

  define(
    "get_routing",
    {
      module: "routings",
      resource: { name: "routings", op: "get" },
      title: "Read a routing",
      description:
        "One routing with every version (draft, approved, superseded), each with its ordered operations, work centres, setup and run minutes and expected cost per yield of the bill.",
      annotations: READ,
      input: { workspace: workspaceParam, routing_id: z.uuid() },
    },
    async ({ workspace, routing_id: id }, api) => {
      const slug = await slugOf(api, workspace);
      return api.call(ws(api).routings[":id"].$get({ param: { slug, id } }));
    },
  );

  define(
    "create_routing",
    {
      module: "routings",
      title: "Create a routing",
      description:
        "Create the routing of a bill of materials (one per bill), optionally with a first draft of its operations. A person approves the draft in the app before job cards can be made from it.",
      annotations: CREATE,
      input: {
        workspace: workspaceParam,
        code: z.string().min(1).max(40),
        name: z.string().min(1).max(200),
        bom_id: z.uuid().describe("The bill of materials (recipe) it makes."),
        description: z.string().max(2000).optional(),
        operations: operationInput.optional(),
      },
    },
    async ({ workspace, code, name, bom_id, description, operations: ops }, api) => {
      const slug = await slugOf(api, workspace);
      return api.call(
        ws(api).routings.$post({
          param: { slug },
          json: {
            code,
            name,
            recipeId: bom_id,
            ...(description ? { description } : {}),
            ...(ops ? { draft: { operations: operations(ops) } } : {}),
          },
        }),
      );
    },
  );

  define(
    "save_routing_draft",
    {
      module: "routings",
      title: "Save a routing draft",
      description:
        "Replace a routing's draft operations (starting the next version when it has none). The approved version keeps running batches until a person approves the draft.",
      annotations: CREATE,
      input: {
        workspace: workspaceParam,
        routing_id: z.uuid(),
        change_note: z.string().max(2000).optional(),
        operations: operationInput,
      },
    },
    async ({ workspace, routing_id: id, change_note, operations: ops }, api) => {
      const slug = await slugOf(api, workspace);
      return api.call(
        ws(api).routings[":id"].draft.$put({
          param: { slug, id },
          json: { operations: operations(ops), ...(change_note ? { changeNote: change_note } : {}) },
        }),
      );
    },
  );

  define(
    "list_job_cards",
    {
      module: "routings",
      resource: { name: "job_cards", op: "list" },
      title: "List job cards",
      description:
        "Job cards (one per operation of a production batch) with batch, work centre, good and scrap, expected and actual minutes and cost. Filter by `status` (open by default: not started or in progress; or one status, or all), `batch_id` and `work_centre_id`. Paged.",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        status: z.enum([...jobCardStatuses, "open", "all"]).optional(),
        batch_id: z.uuid().optional(),
        work_centre_id: z.uuid().optional(),
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
      },
    },
    async ({ workspace, status, batch_id, work_centre_id, limit, offset }, api) => {
      const slug = await slugOf(api, workspace);
      const page = await api.call(
        ws(api).routings["job-cards"].$get({
          param: { slug },
          query: {
            ...(status ? { status } : {}),
            ...(batch_id ? { batchId: batch_id } : {}),
            ...(work_centre_id ? { workCentreId: work_centre_id } : {}),
            ...(limit !== undefined ? { limit: String(limit) } : {}),
            ...(offset !== undefined ? { offset: String(offset) } : {}),
          },
        }),
      );
      return { ...page, hasMore: page.offset + page.jobCards.length < page.total };
    },
  );

  define(
    "get_job_card",
    {
      module: "routings",
      resource: { name: "job_cards", op: "get" },
      title: "Read a job card",
      description:
        "One job card: its place in the batch's sequence (and how much it may still report), time logs, good and scrap entries, exceptions and the batch records (materials, output) posted from it.",
      annotations: READ,
      input: { workspace: workspaceParam, job_card_id: z.uuid() },
    },
    async ({ workspace, job_card_id: id }, api) => {
      const slug = await slugOf(api, workspace);
      return api.call(ws(api).routings["job-cards"][":id"].$get({ param: { slug, id } }));
    },
  );

  define(
    "create_job_cards",
    {
      module: "routings",
      title: "Make a batch's job cards",
      description:
        "Make one job card per operation of a planned or in-progress production batch, from its bill's approved routing, with expected minutes scaled to the batch.",
      annotations: CREATE,
      input: { workspace: workspaceParam, batch_id: z.uuid() },
    },
    async ({ workspace, batch_id: batchId }, api) => {
      const slug = await slugOf(api, workspace);
      return api.call(ws(api).routings.batches[":batchId"]["job-cards"].$post({ param: { slug, batchId } }));
    },
  );

  define(
    "record_job_card_time",
    {
      module: "routings",
      title: "Record time on a job card",
      description:
        "Log minutes worked on an operation (as the token's user), optionally from a start time. The batch must have started.",
      annotations: CREATE,
      input: {
        workspace: workspaceParam,
        job_card_id: z.uuid(),
        minutes: z.number().int().min(1).max(1440),
        started_at: z.iso.datetime({ offset: true }).optional(),
        note: z.string().max(500).optional(),
      },
    },
    async ({ workspace, job_card_id: id, minutes, started_at, note }, api) => {
      const slug = await slugOf(api, workspace);
      return api.call(
        ws(api).routings["job-cards"][":id"].time.$post({
          param: { slug, id },
          json: { minutes, ...(started_at ? { startedAt: started_at } : {}), ...(note ? { note } : {}) },
        }),
      );
    },
  );

  define(
    "record_job_card_quantity",
    {
      module: "routings",
      title: "Report good and scrap on a job card",
      description:
        "Report good and scrapped quantities at an operation, in a unit of the batch's output item. An operation can't report more than the one before it passed as good, and the first can't report more than the batch's planned quantity unless over_planned is true (only when more really was made); scrap needs a reason.",
      annotations: CREATE,
      input: {
        workspace: workspaceParam,
        job_card_id: z.uuid(),
        good: z.number().min(0).optional(),
        scrap: z.number().min(0).optional(),
        unit: z.enum(unitCodes),
        scrap_reason: z.string().max(500).optional(),
        note: z.string().max(500).optional(),
        over_planned: z.boolean().optional(),
      },
    },
    async ({ workspace, job_card_id: id, good, scrap, unit, scrap_reason, note, over_planned }, api) => {
      const slug = await slugOf(api, workspace);
      return api.call(
        ws(api).routings["job-cards"][":id"].quantities.$post({
          param: { slug, id },
          json: {
            good: good ?? 0,
            scrap: scrap ?? 0,
            unit,
            ...(scrap_reason ? { scrapReason: scrap_reason } : {}),
            ...(note ? { note } : {}),
            ...(over_planned ? { overPlanned: true } : {}),
          },
        }),
      );
    },
  );

  define(
    "raise_job_card_exception",
    {
      module: "routings",
      title: "Raise an exception on a job card",
      description:
        "Record something that went wrong at an operation (machine, material, quality, labour, delay, other). An open exception blocks completing the job card until it is resolved.",
      annotations: CREATE,
      input: {
        workspace: workspaceParam,
        job_card_id: z.uuid(),
        kind: z.enum(jobCardExceptionKinds),
        description: z.string().min(1).max(2000),
      },
    },
    async ({ workspace, job_card_id: id, kind, description }, api) => {
      const slug = await slugOf(api, workspace);
      return api.call(
        ws(api).routings["job-cards"][":id"].exceptions.$post({
          param: { slug, id },
          json: { kind, description },
        }),
      );
    },
  );

  define(
    "complete_job_card",
    {
      module: "routings",
      title: "Complete a job card",
      description:
        "Complete an operation once the one before it is complete, its exceptions are resolved and it has reported good or scrap. Running timers on it stop.",
      annotations: CREATE,
      input: { workspace: workspaceParam, job_card_id: z.uuid(), note: z.string().max(2000).optional() },
    },
    async ({ workspace, job_card_id: id, note }, api) => {
      const slug = await slugOf(api, workspace);
      return api.call(
        ws(api).routings["job-cards"][":id"].complete.$post({
          param: { slug, id },
          json: note ? { note } : {},
        }),
      );
    },
  );
}
