import {
  hseListSchema,
  hsePageSchema,
  hseCreateSchema,
  hseSaveSchema,
  hsePermitListSchema,
  hsePermitCreateSchema,
  hsePermitSaveSchema,
  hseReportableKinds,
  newId,
} from "@knotworking/core";
import { z } from "zod";
import { READ, type ToolContext } from "./shared";
import { ToolError } from "../api";
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
export function registerHseTools({ define, slugOf, workspaceParam }: ToolContext) {
  define(
    "list_hse_registers",
    {
      module: "hse",
      resource: { name: "hse_records", op: "list" },
      title: "List HSE registers and attention",
      description:
        "Paged controlled risk/COSHH, contractor competence, inspection, emergency, waste, utility and environmental-obligation registers. Attention includes review/check dates and explicitly unresolved failures. This is recorded scope, not proof of full site coverage. No restricted accident or health records.",
      annotations: READ,
      input: { workspace: workspaceParam, ...hseListSchema.shape },
    },
    async ({ workspace, ...q }, api) => {
      const slug = await slugOf(api, workspace);
      return api.call(
        api.client.v1.workspaces[":slug"].hse.registers.$get({
          param: { slug },
          query: { ...q, limit: String(q.limit), offset: String(q.offset) },
        }),
      );
    },
  );
  define(
    "get_hse_record",
    {
      module: "hse",
      resource: { name: "hse_records", op: "get" },
      title: "Read HSE evidence",
      description:
        "Read current approved and draft content, paginated retained assessment versions, or checks/exercises/measurements. A pass does not silently resolve an earlier failure. Personal incident evidence is never available through this tool.",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        record_id: z.uuid(),
        section: z.enum(["current", "history", "entries"]).default("current"),
        ...hsePageSchema.shape,
      },
    },
    async ({ workspace, record_id: id, section, limit, offset }, api) => {
      const slug = await slugOf(api, workspace),
        route = api.client.v1.workspaces[":slug"].hse.registers[":id"];
      return section === "current"
        ? api.call(route.$get({ param: { slug, id } }))
        : section === "history"
          ? api.call(
              route.history.$get({
                param: { slug, id },
                query: { limit: String(limit), offset: String(offset) },
              }),
            )
          : api.call(
              route.entries.$get({
                param: { slug, id },
                query: { limit: String(limit), offset: String(offset) },
              }),
            );
    },
  );
  define(
    "draft_hse_register",
    {
      module: "hse",
      title: "Prepare HSE assessment draft",
      description:
        "Create or save a draft register using a durable commandId and the reviewed revision for edits. Reuse the same commandId on identical retries. Earlier approved evidence remains in force while the new review is drafted. This cannot approve, archive, sign a verification, or handle private incidents.",
      annotations: WRITE,
      input: {
        workspace: workspaceParam,
        record_id: z.uuid().optional(),
        request: z.union([hseCreateSchema, hseSaveSchema]),
      },
    },
    async ({ workspace, record_id: id, request }, api) => {
      const slug = await slugOf(api, workspace),
        route = api.client.v1.workspaces[":slug"].hse.registers;
      if (id) {
        const p = hseSaveSchema.safeParse(request);
        if (!p.success)
          throw new ToolError("invalid_input", "Edits need a reviewed revision, content and reason");
        return api.call(route[":id"].draft.$put({ param: { slug, id }, json: p.data }));
      }
      const p = hseCreateSchema.safeParse(request);
      if (!p.success) throw new ToolError("invalid_input", "New drafts need a title, kind and content");
      return api.call(route.$post({ param: { slug }, json: p.data }));
    },
  );
  define(
    "list_hse_permits",
    {
      module: "hse",
      requiresModules: ["assets"],
      resource: { name: "hse_permits", op: "list" },
      title: "List contractor permits",
      description:
        "Paged contractor work permits and expiry flags. Issued/suspended asset isolations persist until signed return to service, including after permit expiry or HSE being hidden. No work is authorised by this tool.",
      annotations: READ,
      input: { workspace: workspaceParam, ...hsePermitListSchema.shape },
    },
    async ({ workspace, ...q }, api) => {
      const slug = await slugOf(api, workspace);
      return api.call(
        api.client.v1.workspaces[":slug"].hse.permits.$get({
          param: { slug },
          query: { ...q, limit: String(q.limit), offset: String(q.offset) },
        }),
      );
    },
  );
  define(
    "get_hse_permit",
    {
      module: "hse",
      requiresModules: ["assets"],
      resource: { name: "hse_permits", op: "get" },
      title: "Read permit and decision evidence",
      description:
        "Read the permit, issue-time contractor/assessment/training snapshot, or paginated decision history. Only a signed-in HSE manager may issue, suspend, resume or sign return to service; Site hygiene clearance is separate.",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        permit_id: z.uuid(),
        history: z.boolean().default(false),
        ...hsePageSchema.shape,
      },
    },
    async ({ workspace, permit_id: id, history, limit, offset }, api) => {
      const slug = await slugOf(api, workspace),
        route = api.client.v1.workspaces[":slug"].hse.permits[":id"];
      return history
        ? api.call(
            route.history.$get({
              param: { slug, id },
              query: { limit: String(limit), offset: String(offset) },
            }),
          )
        : api.call(route.$get({ param: { slug, id } }));
    },
  );
  define(
    "draft_hse_permit",
    {
      module: "hse",
      requiresModules: ["assets"],
      title: "Prepare contractor work permit",
      description:
        "Prepare a draft against an existing asset of the register (Assets), signed HSE assessments and contractor competence. Existing Training records remain authoritative. Optional visitor references additionally require Attendance read access. A draft cannot authorise work, create an isolation or return equipment to service. Stable command IDs and reviewed revisions protect retries/edits.",
      annotations: WRITE,
      input: {
        workspace: workspaceParam,
        permit_id: z.uuid().optional(),
        request: z.union([hsePermitCreateSchema, hsePermitSaveSchema]),
      },
    },
    async ({ workspace, permit_id: id, request }, api) => {
      const slug = await slugOf(api, workspace),
        route = api.client.v1.workspaces[":slug"].hse.permits;
      if (id) {
        const p = hsePermitSaveSchema.safeParse(request);
        if (!p.success)
          throw new ToolError("invalid_input", "Edits need a reviewed revision, body and reason");
        return api.call(route[":id"].$put({ param: { slug, id }, json: p.data }));
      }
      const p = hsePermitCreateSchema.safeParse(request);
      if (!p.success) throw new ToolError("invalid_input", "New permits need a title and work body");
      return api.call(route.$post({ param: { slug }, json: p.data }));
    },
  );
  define(
    "report_hse_near_miss",
    {
      module: "hse",
      title: "Report a near miss or unsafe condition",
      description:
        "Reports a near miss, unsafe condition or act, dangerous occurrence or environmental incident in which nobody was hurt, so the people who investigate restricted incidents can follow it up. Returns only the reference: incidents themselves, and anything about people hurt, are never available to tools. An injury must be recorded by a person in the app.",
      annotations: { ...WRITE, idempotentHint: false },
      input: {
        workspace: workspaceParam,
        kind: z.enum(hseReportableKinds),
        occurred_on: z.iso.date().describe("The date it happened (workspace time zone), not in the future."),
        place: z.string().min(1).max(500),
        summary: z.string().min(1).max(3000),
        immediate_actions: z.string().max(4000).optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      return api.call(
        api.client.v1.workspaces[":slug"].hse.reports.$post({
          param: { slug },
          json: {
            commandId: newId(),
            kind: a.kind,
            occurredOn: a.occurred_on,
            place: a.place,
            summary: a.summary,
            immediateActions: a.immediate_actions ?? "",
          },
        }),
      );
    },
  );
}
