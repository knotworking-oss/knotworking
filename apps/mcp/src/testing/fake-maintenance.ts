import {
  describeFrequency,
  maintenanceTaskCreateSchema,
  maintenanceTaskUpdateSchema,
  newId,
  siteAssetUpdateSchema,
  workOrderCreateSchema,
  workOrderTotalCost,
  workOrderUpdateSchema,
} from "@knotworking/core";
import type { Context, Hono } from "hono";
import type { ZodType } from "zod";

export function mountFakeMaintenance(app: Hono, ws: string, register: { assets: Record<string, any>[] }) {
  const err = (code: string, message: string) => ({ error: { code, message } });

  const areaOf = (id: string | null | undefined) => {
    const area = register.assets.find((a) => a.id === id && a.kind === "area");
    return area ? { id: area.id, code: area.code, name: area.name, status: area.status } : null;
  };

  const page = <T>(rows: T[], q: Record<string, string>) => {
    const limit = Number(q.limit ?? 50);
    const offset = Number(q.offset ?? 0);
    return { rows: rows.slice(offset, offset + limit), total: rows.length, limit, offset };
  };
  const parse = async <T>(c: Context, schema: ZodType<T>) => {
    const parsed = schema.safeParse(await c.req.json());
    return parsed.success
      ? { data: parsed.data as T & { id?: string } }
      : { response: c.json(err("invalid_input", parsed.error.message), 400) };
  };

  const assets = register.assets;
  const tasks: Record<string, any>[] = [];
  const workOrders: Record<string, any>[] = [];
  // Maintenance: any asset of the register, with its link to a calibration instrument.
  const links = new Map<string, string | null>();
  const assetView = (a: Record<string, any>) => ({
    id: a.id,
    kind: a.kind,
    code: a.code,
    name: a.name,
    location: a.location,
    areaId: a.parentAreaId,
    status: a.status,
    calibrationInstrumentId: links.get(a.id) ?? null,
    area: areaOf(a.parentAreaId),
    calibrationInstrument: null,
  });

  const taskView = (t: Record<string, any>) => ({
    ...t,
    frequencyText: describeFrequency(t.frequency),
    asset: assets.find((a) => a.id === t.assetId) ?? null,
    lastRecord: null,
    due: { state: "due", dueOn: null },
  });

  for (const base of [`${ws}/maintenance`, `${ws}/site/maintenance`]) {
    app.get(`${base}/assets`, (c) => c.json({ assets: assets.map(assetView) }));
    app.patch(`${base}/assets/:id`, async (c) => {
      const { data, response } = await parse(c, siteAssetUpdateSchema);
      if (response) return response;
      const row = assets.find((a) => a.id === c.req.param("id"));
      if (!row) return c.json(err("not_found", "Asset not found"), 404);
      links.set(row.id, data!.calibrationInstrumentId);
      return c.json(assetView(row));
    });
    app.get(`${base}/tasks`, (c) => c.json({ tasks: tasks.map(taskView) }));
    app.post(`${base}/tasks`, async (c) => {
      const { data, response } = await parse(c, maintenanceTaskCreateSchema);
      if (response) return response;
      if (!assets.some((a) => a.id === data!.assetId))
        return c.json(err("not_found", "Asset not found"), 404);
      const row = {
        ...data!,
        id: newId(),
        description: data!.description ?? null,
        startOn: data!.startOn ?? null,
        status: "active",
      };
      tasks.push(row);
      return c.json(taskView(row), 201);
    });
    app.patch(`${base}/tasks/:id`, async (c) => {
      const { data, response } = await parse(c, maintenanceTaskUpdateSchema);
      if (response) return response;
      const row = tasks.find((t) => t.id === c.req.param("id"));
      if (!row) return c.json(err("not_found", "Maintenance task not found"), 404);
      Object.assign(row, data);
      return c.json(taskView(row));
    });
    app.get(`${base}/records`, (c) => c.json({ records: [], total: 0, limit: 50, offset: 0 }));

    // Work orders.
    const workOrderView = (w: Record<string, any>) => ({
      ...w,
      asset: assets.find((a) => a.id === w.assetId) ?? null,
      area: areaOf(assets.find((a) => a.id === w.assetId)?.parentAreaId),
      requestedByName: "Agent",
      assignedToName: null,
      totalCost: workOrderTotalCost(w as never),
    });
    app.get(`${base}/work-orders`, (c) => {
      const status = c.req.query("status") ?? "open";
      const rows = workOrders.filter((w) =>
        status === "all"
          ? true
          : status === "open"
            ? ["requested", "in_progress"].includes(w.status)
            : w.status === status,
      );
      const p = page(rows, c.req.query());
      return c.json({
        workOrders: p.rows.map(workOrderView),
        total: p.total,
        limit: p.limit,
        offset: p.offset,
      });
    });
    app.post(`${base}/work-orders`, async (c) => {
      const { data, response } = await parse(c, workOrderCreateSchema);
      if (response) return response;
      if (!assets.some((a) => a.id === data!.assetId))
        return c.json(err("not_found", "Asset not found"), 404);
      const row = {
        ...data!,
        id: newId(),
        description: data!.description ?? null,
        contractor: data!.contractor ?? null,
        status: "requested",
        source: "api",
        workDone: null,
        sparesUsed: null,
        partsCost: null,
        labourCost: null,
        contractorCost: null,
        downtimeMinutes: null,
        completedAt: null,
      };
      workOrders.unshift(row);
      return c.json(workOrderView(row), 201);
    });
    app.patch(`${base}/work-orders/:id`, async (c) => {
      const { data, response } = await parse(c, workOrderUpdateSchema);
      if (response) return response;
      const row = workOrders.find((w) => w.id === c.req.param("id"));
      if (!row) return c.json(err("not_found", "Work order not found"), 404);
      if (!["requested", "in_progress"].includes(row.status)) {
        return c.json(err("work_order_closed", "This work order is closed"), 409);
      }
      Object.assign(row, data);
      return c.json(workOrderView(row));
    });
    app.get(`${base}/work-orders/:id`, (c) => {
      const row = workOrders.find((w) => w.id === c.req.param("id"));
      return row ? c.json(workOrderView(row)) : c.json(err("not_found", "Work order not found"), 404);
    });
  }
  return { tasks, workOrders };
}
