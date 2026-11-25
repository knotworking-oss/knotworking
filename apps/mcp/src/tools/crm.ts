import {
  crmActivityCreateSchema,
  crmActivityListSchema,
  crmActivityUpdateSchema,
  crmLeadConvertSchema,
  crmLeadCreateSchema,
  crmLeadListSchema,
  crmLeadUpdateSchema,
  crmOpportunityCreateSchema,
  crmOpportunityListSchema,
  crmOpportunityUpdateSchema,
  crmOutcomeSchema,
  newId,
} from "@knotworking/core";
import { z } from "zod";
import { ToolError, type Api } from "../api";
import { CREATE, READ, type ToolContext } from "./shared";

const SAVE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new ToolError("invalid_input", parsed.error.issues.map((issue) => issue.message).join("; "));
  return parsed.data;
}

/**
 * CRM: leads, opportunities, the pipeline and follow-ups. Handing a won opportunity off to an order or
 * delivery project is a person's signed decision in Sales or Client services, so there is no tool for it.
 */
export function registerCrmTools({ define, slugOf, workspaceParam }: ToolContext) {
  const crm = (api: Api) => api.client.v1.workspaces[":slug"].crm;

  define(
    "list_crm_leads",
    {
      module: "crm",
      resource: { name: "crm_leads", op: "list" },
      title: "List CRM leads",
      description:
        "Leads newest first, filtered by status, owner or a search of name, company and reference. Use nextCursor as before for the next page.",
      annotations: READ,
      input: { workspace: workspaceParam, ...crmLeadListSchema.shape },
    },
    async ({ workspace, ...query }, api) => {
      const slug = await slugOf(api, workspace);
      return api.call(crm(api).leads.$get({ param: { slug }, query }));
    },
  );
  define(
    "get_crm_lead",
    {
      module: "crm",
      resource: { name: "crm_leads", op: "get" },
      title: "Read a CRM lead",
      description:
        "A lead with its contact details, the customer it converted to, its opportunities and activities.",
      annotations: READ,
      input: { workspace: workspaceParam, lead_id: z.uuid() },
    },
    async ({ workspace, lead_id: id }, api) => {
      const slug = await slugOf(api, workspace);
      return api.call(crm(api).leads[":id"].$get({ param: { slug, id } }));
    },
  );
  define(
    "save_crm_lead",
    {
      module: "crm",
      title: "Create or edit a CRM lead",
      description:
        "Without lead_id: create from { name, company?, email?, phone?, source?, notes?, ownerId? }. With lead_id: change those fields or status (new, contacted, qualified, disqualified with statusReason) and pass expectedRevision from the lead you read. The owner must have CRM access.",
      annotations: SAVE,
      input: {
        workspace: workspaceParam,
        lead_id: z.uuid().optional(),
        lead: z.record(z.string(), z.unknown()),
      },
    },
    async ({ workspace, lead_id: id, lead }, api) => {
      const slug = await slugOf(api, workspace);
      if (id)
        return api.call(
          crm(api).leads[":id"].$patch({ param: { slug, id }, json: parse(crmLeadUpdateSchema, lead) }),
        );
      const json = parse(crmLeadCreateSchema, { commandId: newId(), ...lead });
      return api.call(crm(api).leads.$post({ param: { slug }, json }));
    },
  );
  define(
    "convert_crm_lead",
    {
      module: "crm",
      title: "Convert a qualified lead into a customer",
      description:
        'Turns a qualified lead into a customer: customer { mode: "new", code, name, address, contactName?, email?, phone? } adds one to the register (needs Customers write access), or { mode: "existing", customerId } links one. Its opportunities without a customer get this one. Pass expectedRevision from the lead.',
      annotations: CREATE,
      input: {
        workspace: workspaceParam,
        lead_id: z.uuid(),
        expected_revision: z.number().int().positive(),
        customer: z.record(z.string(), z.unknown()),
      },
    },
    async ({ workspace, lead_id: id, expected_revision, customer }, api) => {
      const slug = await slugOf(api, workspace);
      const json = parse(crmLeadConvertSchema, {
        commandId: newId(),
        expectedRevision: expected_revision,
        customer,
      });
      return api.call(crm(api).leads[":id"].convert.$post({ param: { slug, id }, json }));
    },
  );

  define(
    "list_crm_opportunities",
    {
      module: "crm",
      resource: { name: "crm_opportunities", op: "list" },
      title: "List CRM opportunities",
      description:
        "Opportunities (open by default; status won, lost or all) with stage, customer or lead, value, owner, linked quote and handoff. Filter by stage, owner, customer or lead. Use nextCursor as before.",
      annotations: READ,
      input: { workspace: workspaceParam, ...crmOpportunityListSchema.shape },
    },
    async ({ workspace, ...query }, api) => {
      const slug = await slugOf(api, workspace);
      return api.call(crm(api).opportunities.$get({ param: { slug }, query }));
    },
  );
  define(
    "get_crm_opportunity",
    {
      module: "crm",
      resource: { name: "crm_opportunities", op: "get" },
      title: "Read a CRM opportunity",
      description:
        "An opportunity with its stage, customer or lead, linked Sales or Client services quote, the order or delivery project it was handed off to, its outcome and activities.",
      annotations: READ,
      input: { workspace: workspaceParam, opportunity_id: z.uuid() },
    },
    async ({ workspace, opportunity_id: id }, api) => {
      const slug = await slugOf(api, workspace);
      return api.call(crm(api).opportunities[":id"].$get({ param: { slug, id } }));
    },
  );
  define(
    "get_crm_pipeline",
    {
      module: "crm",
      title: "See the sales pipeline",
      description:
        "Open opportunities by stage with counts, value and probability-weighted value per currency, and recent won and lost deals. Optionally for one owner.",
      annotations: READ,
      input: { workspace: workspaceParam, owner_id: z.uuid().optional() },
    },
    async ({ workspace, owner_id }, api) => {
      const slug = await slugOf(api, workspace);
      return api.call(crm(api).pipeline.$get({ param: { slug }, query: { ownerId: owner_id } }));
    },
  );
  define(
    "save_crm_opportunity",
    {
      module: "crm",
      title: "Create, move or edit a CRM opportunity",
      description:
        "Without opportunity_id: create from { title, customerId or leadId, currency, value?, stageId? (default: first stage), ownerId?, expectedCloseDate?, notes?, salesQuoteId?, serviceQuoteId? }. With opportunity_id: change those fields (stageId moves it along the pipeline) and pass expectedRevision. A linked quote must be the same customer's; linking needs read access to Sales or Client services.",
      annotations: SAVE,
      input: {
        workspace: workspaceParam,
        opportunity_id: z.uuid().optional(),
        opportunity: z.record(z.string(), z.unknown()),
      },
    },
    async ({ workspace, opportunity_id: id, opportunity }, api) => {
      const slug = await slugOf(api, workspace);
      if (id)
        return api.call(
          crm(api).opportunities[":id"].$patch({
            param: { slug, id },
            json: parse(crmOpportunityUpdateSchema, opportunity),
          }),
        );
      const json = parse(crmOpportunityCreateSchema, { commandId: newId(), ...opportunity });
      return api.call(crm(api).opportunities.$post({ param: { slug }, json }));
    },
  );
  define(
    "record_crm_outcome",
    {
      module: "crm",
      title: "Record a won or lost opportunity",
      description:
        "Close an open opportunity as won or lost with the reason, or reopen a closed one that was not handed off. Pass expectedRevision. Handing a won deal to an order or delivery project is done by a person in the app.",
      annotations: CREATE,
      input: {
        workspace: workspaceParam,
        opportunity_id: z.uuid(),
        expected_revision: z.number().int().positive(),
        outcome: crmOutcomeSchema.shape.outcome,
        reason: z.string().trim().min(1).max(2000),
      },
    },
    async ({ workspace, opportunity_id: id, expected_revision, outcome, reason }, api) => {
      const slug = await slugOf(api, workspace);
      const json = parse(crmOutcomeSchema, {
        commandId: newId(),
        expectedRevision: expected_revision,
        outcome,
        reason,
      });
      return api.call(crm(api).opportunities[":id"].outcome.$post({ param: { slug, id }, json }));
    },
  );

  define(
    "list_crm_follow_ups",
    {
      module: "crm",
      resource: { name: "crm_follow_ups", op: "list" },
      title: "List CRM follow-ups and activities",
      description:
        "Calls, emails, meetings and to-dos on leads and opportunities. Open ones first by due date. Filter by lead, opportunity, owner (mine or all), status (open, done, all) and dueBy.",
      annotations: READ,
      input: { workspace: workspaceParam, ...crmActivityListSchema.shape },
    },
    async ({ workspace, limit, offset, ...query }, api) => {
      const slug = await slugOf(api, workspace);
      return api.call(
        crm(api).activities.$get({
          param: { slug },
          query: { ...query, limit: String(limit), offset: String(offset) },
        }),
      );
    },
  );
  define(
    "save_crm_follow_up",
    {
      module: "crm",
      title: "Log an activity or plan a follow-up",
      description:
        "Without activity_id: create from { leadId or opportunityId, kind (call, email, meeting, task, note), subject, notes?, dueOn?, ownerId? (default you), done? }. With activity_id: change those fields, or set done true or false. A new owner is notified.",
      annotations: SAVE,
      input: {
        workspace: workspaceParam,
        activity_id: z.uuid().optional(),
        activity: z.record(z.string(), z.unknown()),
      },
    },
    async ({ workspace, activity_id: id, activity }, api) => {
      const slug = await slugOf(api, workspace);
      if (id)
        return api.call(
          crm(api).activities[":id"].$patch({
            param: { slug, id },
            json: parse(crmActivityUpdateSchema, activity),
          }),
        );
      const json = parse(crmActivityCreateSchema, { commandId: newId(), ...activity });
      return api.call(crm(api).activities.$post({ param: { slug }, json }));
    },
  );
}
