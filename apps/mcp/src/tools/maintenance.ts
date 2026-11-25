import {
  maintenanceTaskCreateSchema,
  maintenanceTaskUpdateSchema,
  workOrderKinds,
  workOrderPriorities,
  workOrderStatuses,
} from "@knotworking/core";
import { z } from "zod";
import { ToolError, type Api } from "../api";
import { CREATE, READ, dateParam, limitParam, offsetParam, pickReference, type ToolContext } from "./shared";

export function registerMaintenanceTools({ define, slugOf, workspaceParam }: ToolContext) {
  const ws = (api: Api) => api.client.v1.workspaces[":slug"].maintenance;
  const assetRef = async (api: Api, slug: string, ref: string) =>
    pickReference(
      (await api.call(ws(api).assets.$get({ param: { slug }, query: { status: "all" } }))).assets,
      ref,
      (a) => [a.code, a.name],
      "asset",
      "Use the Assets register to find the asset ID.",
    );

  define(
    "list_maintenance_tasks",
    {
      module: "maintenance",
      resource: { name: "maintenance_tasks", op: "list" },
      title: "List recurring maintenance tasks",
      description:
        "Maintenance schedules, due dates and their last completion. Filter by asset ID or task status.",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        asset_id: z.uuid().optional(),
        status: z.enum(["active", "archived", "all"]).optional(),
      },
    },
    async ({ workspace, asset_id, status }, api) => {
      const slug = await slugOf(api, workspace);
      return api.call(ws(api).tasks.$get({ param: { slug }, query: { assetId: asset_id, status } }));
    },
  );

  define(
    "save_maintenance_task",
    {
      module: "maintenance",
      title: "Create or update a recurring maintenance task",
      description:
        "Set the asset (ID, code or name), title, description, frequency {every, unit}, or startOn (first due date). Pass id to change an existing task. An asset that requires return-to-service clearance needs an area.",
      annotations: CREATE,
      input: {
        workspace: workspaceParam,
        id: z.uuid().optional(),
        asset: z.string().min(1).max(200).optional(),
        task: z.record(z.string(), z.unknown()),
      },
    },
    async ({ workspace, id, asset, task }, api) => {
      const slug = await slugOf(api, workspace);
      const body = { ...task, ...(asset && { assetId: await assetRef(api, slug, asset) }) };
      const parsed = (id ? maintenanceTaskUpdateSchema : maintenanceTaskCreateSchema).safeParse(body);
      if (!parsed.success)
        throw new ToolError("invalid_input", parsed.error.issues.map((issue) => issue.message).join("; "));
      return id
        ? api.call(ws(api).tasks[":id"].$patch({ param: { slug, id }, json: body as never }))
        : api.call(ws(api).tasks.$post({ param: { slug }, json: body as never }));
    },
  );

  define(
    "list_maintenance_records",
    {
      module: "maintenance",
      resource: { name: "maintenance_records", op: "list" },
      title: "List completed maintenance",
      description:
        "Completed work, corrections, clearance and next due dates. Filter by asset or task ID, dates, or pending clearance.",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        asset_id: z.uuid().optional(),
        task_id: z.uuid().optional(),
        from: dateParam.optional(),
        to: dateParam.optional(),
        awaiting_clearance: z.boolean().optional(),
        limit: limitParam(50, 200),
        offset: offsetParam,
      },
    },
    async ({ workspace, asset_id, task_id, from, to, awaiting_clearance, limit, offset }, api) => {
      const slug = await slugOf(api, workspace);
      const page = await api.call(
        ws(api).records.$get({
          param: { slug },
          query: {
            assetId: asset_id,
            taskId: task_id,
            from,
            to,
            awaitingClearance:
              awaiting_clearance === undefined ? undefined : awaiting_clearance ? "true" : "false",
            limit: limit?.toString(),
            offset: offset?.toString(),
          },
        }),
      );
      return { ...page, hasMore: page.offset + page.records.length < page.total };
    },
  );

  define(
    "get_maintenance_record",
    {
      module: "maintenance",
      resource: { name: "maintenance_records", op: "get" },
      title: "Read completed maintenance",
      description: "One completed maintenance record, with work, asset and clearance details.",
      annotations: READ,
      input: { workspace: workspaceParam, record_id: z.uuid() },
    },
    async ({ workspace, record_id }, api) => {
      const slug = await slugOf(api, workspace);
      return api.call(ws(api).records[":id"].$get({ param: { slug, id: record_id } }));
    },
  );

  define(
    "list_maintenance_work_orders",
    {
      module: "maintenance",
      resource: { name: "maintenance_work_orders", op: "list" },
      title: "List work orders",
      description:
        "Breakdowns and work requests, with assignment, spares and costs. Open orders are shown by default.",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        asset_id: z.uuid().optional(),
        status: z.enum(["open", ...workOrderStatuses, "all"]).optional(),
        priority: z.enum(workOrderPriorities).optional(),
        kind: z.enum(workOrderKinds).optional(),
        limit: limitParam(50, 200),
        offset: offsetParam,
      },
    },
    async ({ workspace, asset_id, status, priority, kind, limit, offset }, api) => {
      const slug = await slugOf(api, workspace);
      const page = await api.call(
        ws(api)["work-orders"].$get({
          param: { slug },
          query: {
            assetId: asset_id,
            status,
            priority,
            kind,
            limit: limit?.toString(),
            offset: offset?.toString(),
          },
        }),
      );
      return { ...page, hasMore: page.offset + page.workOrders.length < page.total };
    },
  );

  define(
    "get_maintenance_work_order",
    {
      module: "maintenance",
      resource: { name: "maintenance_work_orders", op: "get" },
      title: "Read a work order",
      description: "One breakdown or work request, with work, asset and cost details.",
      annotations: READ,
      input: { workspace: workspaceParam, work_order_id: z.uuid() },
    },
    async ({ workspace, work_order_id }, api) => {
      const slug = await slugOf(api, workspace);
      return api.call(ws(api)["work-orders"][":id"].$get({ param: { slug, id: work_order_id } }));
    },
  );

  define(
    "link_maintenance_calibration",
    {
      module: "maintenance",
      requiresModules: ["haccp"],
      title: "Link a maintained asset to its calibration instrument",
      description:
        "Set the HACCP calibration instrument for a maintained asset. Pass null to remove an existing link.",
      annotations: { ...CREATE, idempotentHint: true },
      input: {
        workspace: workspaceParam,
        asset_id: z.uuid(),
        instrument_id: z.uuid().nullable(),
      },
    },
    async ({ workspace, asset_id, instrument_id }, api) => {
      const slug = await slugOf(api, workspace);
      return api.call(
        ws(api).assets[":id"].$patch({
          param: { slug, id: asset_id },
          json: { calibrationInstrumentId: instrument_id },
        }),
      );
    },
  );

  define(
    "report_breakdown",
    {
      module: "maintenance",
      title: "Report a breakdown or request maintenance work",
      description:
        "Raise a breakdown (equipment that has stopped working) or a work request on a maintained asset, or (with `work_order`, its id) change an open one: start it (`status: in_progress`) or add the spares used and costs so far. Give the `asset` (id, code or name; see the Assets register), a `title`, and say whether the equipment `stops_production`. Recorded as coming from the API. Completing or cancelling a work order is a person's act in the app: there is no tool for it.",
      annotations: CREATE,
      input: {
        workspace: workspaceParam,
        work_order: z.string().uuid().optional().describe("Id of an open work order to update."),
        asset: z.string().min(1).max(200).optional().describe("Asset id, code or name (new ones)."),
        kind: z.enum(workOrderKinds).optional().describe("breakdown (default) or request."),
        title: z.string().min(1).max(200).optional().describe("Required for a new one."),
        description: z.string().max(4000).optional(),
        priority: z.enum(workOrderPriorities).optional(),
        stops_production: z.boolean().optional(),
        status: z.enum(["requested", "in_progress"]).optional().describe("Update only: start the work."),
        spares_used: z.string().max(2000).optional(),
        parts_cost: z.number().min(0).max(10_000_000).optional(),
        labour_cost: z.number().min(0).max(10_000_000).optional(),
        contractor_cost: z.number().min(0).max(10_000_000).optional(),
        contractor: z.string().max(200).optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const view = (w: { id: string; title: string; status: string; priority: string; kind: string }) => ({
        id: w.id,
        title: w.title,
        kind: w.kind,
        priority: w.priority,
        status: w.status,
        note: "A person completes the work order in the app once the work is done.",
      });
      if (a.work_order) {
        if (a.asset || a.kind) {
          throw new ToolError("invalid_input", "The asset and kind are fixed when a work order is raised.");
        }
        return view(
          await api.call(
            ws(api)["work-orders"][":id"].$patch({
              param: { slug, id: a.work_order },
              json: {
                ...(a.title ? { title: a.title } : {}),
                ...(a.description !== undefined ? { description: a.description } : {}),
                ...(a.priority ? { priority: a.priority } : {}),
                ...(a.stops_production !== undefined ? { stopsProduction: a.stops_production } : {}),
                ...(a.status ? { status: a.status } : {}),
                ...(a.spares_used !== undefined ? { sparesUsed: a.spares_used } : {}),
                ...(a.parts_cost !== undefined ? { partsCost: a.parts_cost } : {}),
                ...(a.labour_cost !== undefined ? { labourCost: a.labour_cost } : {}),
                ...(a.contractor_cost !== undefined ? { contractorCost: a.contractor_cost } : {}),
                ...(a.contractor !== undefined ? { contractor: a.contractor } : {}),
              },
            }),
          ),
        );
      }
      if (!a.asset || !a.title) throw new ToolError("invalid_input", "Give the `asset` and a `title`.");
      return view(
        await api.call(
          ws(api)["work-orders"].$post({
            param: { slug },
            json: {
              assetId: await assetRef(api, slug, a.asset),
              title: a.title,
              ...(a.kind ? { kind: a.kind } : {}),
              ...(a.description ? { description: a.description } : {}),
              ...(a.priority ? { priority: a.priority } : {}),
              ...(a.stops_production !== undefined ? { stopsProduction: a.stops_production } : {}),
              ...(a.contractor ? { contractor: a.contractor } : {}),
            },
          }),
        ),
      );
    },
  );
}
