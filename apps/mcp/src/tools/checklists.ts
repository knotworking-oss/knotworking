import {
  checklistActionStatuses,
  checkOutcomes,
  generalChecklistTemplateCreateSchema,
  generalChecklistTemplateUpdateSchema,
} from "@knotworking/core";
import { z } from "zod";
import { ToolError, type Api } from "../api";
import { CREATE, dateParam, limitParam, offsetParam, READ, type ToolContext } from "./shared";

export function registerChecklistTools({ define, slugOf, workspaceParam }: ToolContext) {
  const ws = (api: Api) => api.client.v1.workspaces[":slug"].checklists;

  define(
    "list_checklist_templates",
    {
      module: "checklists",
      resource: { name: "checklist_templates", op: "list" },
      title: "List checklist templates",
      description:
        "General checklist templates, their items, frequency and latest passing check. Active by default.",
      annotations: READ,
      input: { workspace: workspaceParam, status: z.enum(["active", "archived", "all"]).optional() },
    },
    async ({ workspace, status }, api) => {
      const slug = await slugOf(api, workspace);
      return api.call(ws(api).templates.$get({ param: { slug }, query: { status } }));
    },
  );

  define(
    "get_checklist_template",
    {
      module: "checklists",
      resource: { name: "checklist_templates", op: "get" },
      title: "Read a checklist template",
      description: "A checklist template with its items and schedule.",
      annotations: READ,
      input: { workspace: workspaceParam, template_id: z.uuid() },
    },
    async ({ workspace, template_id }, api) => {
      const slug = await slugOf(api, workspace);
      return api.call(ws(api).templates[":id"].$get({ param: { slug, id: template_id } }));
    },
  );

  define(
    "save_checklist_template",
    {
      module: "checklists",
      title: "Create or edit a checklist template",
      description:
        "Fields: name, line (optional free-text location), frequency {every, unit} or null, and items [{id?, prompt, guidance?}]. Pass id to edit. Sending items replaces the item list. Keep the IDs of existing items. An edit may set status to active or archived.",
      annotations: CREATE,
      input: {
        workspace: workspaceParam,
        id: z.uuid().optional(),
        template: z.record(z.string(), z.unknown()),
      },
    },
    async ({ workspace, id, template }, api) => {
      const slug = await slugOf(api, workspace);
      if (id) {
        const parsed = generalChecklistTemplateUpdateSchema.safeParse(template);
        if (!parsed.success)
          throw new ToolError("invalid_input", parsed.error.issues.map((issue) => issue.message).join("; "));
        return api.call(ws(api).templates[":id"].$patch({ param: { slug, id }, json: parsed.data }));
      }
      const parsed = generalChecklistTemplateCreateSchema.safeParse(template);
      if (!parsed.success)
        throw new ToolError("invalid_input", parsed.error.issues.map((issue) => issue.message).join("; "));
      return api.call(ws(api).templates.$post({ param: { slug }, json: parsed.data }));
    },
  );

  define(
    "get_checklists_due",
    {
      module: "checklists",
      title: "See scheduled checks due",
      description: "Due and overdue recurring checklists. Use include all to see every scheduled checklist.",
      annotations: READ,
      input: { workspace: workspaceParam, include: z.enum(["due", "all"]).optional() },
    },
    async ({ workspace, include }, api) => {
      const slug = await slugOf(api, workspace);
      return api.call(ws(api).due.$get({ param: { slug }, query: { include } }));
    },
  );

  define(
    "list_checklist_results",
    {
      module: "checklists",
      resource: { name: "checklist_results", op: "list" },
      title: "List completed checks",
      description:
        "Recorded checks with item results. Filter by template, outcome or inclusive workspace dates.",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        template_id: z.uuid().optional(),
        outcome: z.enum(checkOutcomes).optional(),
        from: dateParam.optional(),
        to: dateParam.optional(),
        limit: limitParam(50, 200),
        offset: offsetParam,
      },
    },
    async ({ workspace, template_id, outcome, from, to, limit, offset }, api) => {
      const slug = await slugOf(api, workspace);
      const page = await api.call(
        ws(api).checks.$get({
          param: { slug },
          query: {
            templateId: template_id,
            outcome,
            from,
            to,
            includeCorrected: "false",
            limit: limit?.toString(),
            offset: offset?.toString(),
          },
        }),
      );
      return { ...page, hasMore: page.offset + page.checks.length < page.total };
    },
  );

  define(
    "get_checklist_result",
    {
      module: "checklists",
      resource: { name: "checklist_results", op: "get" },
      title: "Read a completed check",
      description: "One recorded check, including the original wording, item results and correction links.",
      annotations: READ,
      input: { workspace: workspaceParam, check_id: z.uuid() },
    },
    async ({ workspace, check_id }, api) => {
      const slug = await slugOf(api, workspace);
      return api.call(ws(api).checks[":id"].$get({ param: { slug, id: check_id } }));
    },
  );

  define(
    "list_checklist_actions",
    {
      module: "checklists",
      resource: { name: "checklist_actions", op: "list" },
      title: "List checklist follow-ups",
      description:
        "Follow-up actions opened by failed checks, with failed items and their resolution. Open by default.",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        status: z.enum([...checklistActionStatuses, "all"]).optional(),
        limit: limitParam(50, 200),
        offset: offsetParam,
      },
    },
    async ({ workspace, status, limit, offset }, api) => {
      const slug = await slugOf(api, workspace);
      const page = await api.call(
        ws(api).actions.$get({
          param: { slug },
          query: { status, limit: limit?.toString(), offset: offset?.toString() },
        }),
      );
      return { ...page, hasMore: page.offset + page.actions.length < page.total };
    },
  );
}
