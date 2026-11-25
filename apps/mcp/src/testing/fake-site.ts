import {
  checklistTemplateCreateSchema,
  checklistTemplateUpdateSchema,
  describeFrequency,
  describeStorageLimits,
  describeStorageReading,
  evaluateStorageReading,
  glassBreakageCreateSchema,
  glassBreakageUpdateSchema,
  glassItemCreateSchema,
  glassItemUpdateSchema,
  highestActivity,
  maintenanceTaskCreateSchema,
  maintenanceTaskUpdateSchema,
  newId,
  pestDeviceCreateSchema,
  pestDeviceUpdateSchema,
  pestVisitCreateSchema,
  siteActionCreateSchema,
  siteActionUpdateSchema,
  siteAssetUpdateSchema,
  storageMeasureDefaultUnits,
  storageReadingCreateSchema,
  storageUnitCreateSchema,
  storageUnitUpdateSchema,
  workOrderCreateSchema,
  workOrderTotalCost,
  workOrderUpdateSchema,
} from "@knotworking/core";
import type { Context, Hono } from "hono";
import type { ZodType } from "zod";

/**
 * In-memory stand-in for the site programmes module's routes (apps/server/src/routes/site.ts)
 * that the MCP tools use. Request bodies are checked with the real schemas from
 * `@knotworking/core`. Every request here comes from an API token, so a recorded storage reading
 * is `source: api` and `pending` review, and an out-of-limit one opens a corrective action at
 * once.
 *
 * Seeded with two areas (Packing hall, Dispatch), pest device RB-01, a chiller (0 to 5 °C) and a
 * freezer (at most -18 °C), one overdue pest visit, and a pre-start checklist.
 */
export function mountFakeSite(app: Hono, ws: string, register: { assets: Record<string, any>[] }) {
  const err = (code: string, message: string) => ({ error: { code, message } });
  const now = "2026-11-11T09:00:00.000Z";
  const today = "2026-11-11";

  // Areas and maintained assets are the asset register's (fake-assets.ts).
  const areas = register.assets.filter((a) => a.kind === "area");
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

  // Pest control.
  const devices: Record<string, any>[] = [
    {
      id: newId(),
      kind: "rodent_bait_station",
      code: "RB-01",
      location: "Dock door",
      areaId: areas[1]!.id,
      status: "active",
    },
  ];
  const deviceView = (d: Record<string, any>) => ({
    ...d,
    area: areaOf(d.areaId),
    lastFinding: null,
  });
  const visits: Record<string, any>[] = [
    {
      id: newId(),
      contractor: "Pestaway",
      technician: null,
      visitedOn: "2026-10-01",
      summary: null,
      recommendations: "Proof the dock door",
      actionsTaken: null,
      nextVisitOn: "2026-11-01",
      source: "manual",
      correctedByVisitId: null,
      highestActivity: "low",
      findings: [
        {
          device: { id: devices[0]!.id, code: "RB-01", kind: "rodent_bait_station", location: "Dock door" },
          location: null,
          activity: "low",
          pest: "mice",
          count: 1,
          note: null,
          action: null,
        },
      ],
    },
  ];

  // Registers.
  const glassItems: Record<string, any>[] = [];
  const assets = register.assets;
  const tasks: Record<string, any>[] = [];
  const units: Record<string, any>[] = [
    {
      id: newId(),
      code: "CH-1",
      name: "Chiller 1",
      kind: "chiller",
      location: null,
      areaId: areas[0]!.id,
      limitMin: 0,
      limitMax: 5,
      measure: "temperature",
      unit: "°C",
      readingFrequency: { every: 1, unit: "day" },
      status: "active",
    },
    {
      id: newId(),
      code: null,
      name: "Freezer 1",
      kind: "freezer",
      location: null,
      areaId: null,
      limitMin: null,
      limitMax: -18,
      measure: "temperature",
      unit: "°C",
      readingFrequency: { every: 1, unit: "day" },
      status: "active",
    },
  ];
  const unitView = (u: Record<string, any>) => ({
    ...u,
    area: areaOf(u.areaId),
    limitsText: describeStorageLimits({ limitMin: u.limitMin, limitMax: u.limitMax }, u.unit),
    frequencyText: describeFrequency(u.readingFrequency),
    lastReading: null,
    due: u.status === "active" ? { state: "due", dueOn: null, dueAt: null } : null,
  });
  const templates: Record<string, any>[] = [
    {
      id: newId(),
      name: "Line 1 pre-start",
      kind: "prestart",
      areaId: areas[0]!.id,
      line: "Line 1",
      frequency: { every: 1, unit: "day" },
      duringProduction: false,
      status: "active",
      items: [{ id: newId(), sortOrder: 0, prompt: "Metal detector tested", guidance: null }],
    },
  ];
  const templateView = (t: Record<string, any>) => ({
    ...t,
    area: areaOf(t.areaId),
    frequencyText: t.frequency ? describeFrequency(t.frequency) : null,
    lastCheck: null,
    due: t.frequency ? { state: "due", dueOn: null, dueAt: null } : null,
  });

  // Records.
  const breakages: Record<string, any>[] = [];
  const readings: Record<string, any>[] = [];
  const actions: Record<string, any>[] = [];
  const missing = (a: Record<string, any>) =>
    (["actionTaken", "rootCause", "preventiveAction"] as const).filter((f) => !a[f]);
  const actionView = (a: Record<string, any>) => ({
    ...a,
    missing: missing(a),
    raisedByName: "Ada Lovelace",
    closedByName: null,
    reading: a.readingId
      ? { id: a.readingId, text: readings.find((r) => r.id === a.readingId)?.readingText }
      : null,
  });
  const addAction = (fields: Record<string, any>) => {
    const row: Record<string, any> = {
      id: newId(),
      actionTaken: null,
      rootCause: null,
      preventiveAction: null,
      status: "open",
      source: "api",
      readingId: null,
      closedAt: null,
      closureNote: null,
      createdAt: now,
      ...fields,
    };
    actions.unshift(row);
    return row;
  };

  app.get(`${ws}/site/areas`, (c) =>
    c.json({
      areas: register.assets
        .filter((a) => a.kind === "area")
        .map(({ id, code, name, location, status }) => ({ id, code, name, location, status })),
    }),
  );
  app.get(`${ws}/site/due`, (c) => {
    const q = c.req.query();
    const items = [
      {
        programme: "pest",
        subjectId: "pest-visit",
        title: "Pest control visit (Pestaway)",
        where: null,
        state: "overdue",
        dueOn: "2026-11-01",
        dueAt: null,
        lastAt: "2026-10-01",
        note: null,
      },
      {
        programme: "storage",
        subjectId: units[0]!.id,
        title: "Chiller 1: temperature reading",
        where: null,
        state: "due",
        dueOn: null,
        dueAt: null,
        lastAt: null,
        note: "Daily",
      },
      {
        programme: "checklist",
        subjectId: templates[0]!.id,
        title: "Line 1 pre-start",
        where: "Line 1",
        state: "ok",
        dueOn: "2026-11-12",
        dueAt: null,
        lastAt: now,
        note: "Daily",
      },
    ].filter(
      (i) =>
        (!q.programme || i.programme === q.programme) &&
        (q.include === "all" || ["overdue", "due"].includes(i.state)),
    );
    return c.json({
      today,
      items,
      counts: {
        overdue: 1,
        due: 1,
        awaitingReview: readings.filter((r) => r.reviewStatus === "pending").length,
        awaitingSignOff: 0,
        awaitingClearance: 0,
        openBreakages: breakages.filter((b) => b.status === "open").length,
        openActions: actions.filter((a) => a.status === "open").length,
        pestActivity: 0,
        glassProblems: 0,
        openWorkOrders: workOrders.filter((w) => ["requested", "in_progress"].includes(w.status)).length,
      },
    });
  });

  // Pest control.
  app.get(`${ws}/site/pest/devices`, (c) => c.json({ devices: devices.map(deviceView) }));
  app.post(`${ws}/site/pest/devices`, async (c) => {
    const { data, response } = await parse(c, pestDeviceCreateSchema);
    if (response) return response;
    const row = { ...data!, id: data!.id ?? newId(), areaId: data!.areaId ?? null, status: "active" };
    devices.push(row);
    return c.json(deviceView(row), 201);
  });
  app.patch(`${ws}/site/pest/devices/:id`, async (c) => {
    const { data, response } = await parse(c, pestDeviceUpdateSchema);
    if (response) return response;
    const row = devices.find((d) => d.id === c.req.param("id"));
    if (!row) return c.json(err("not_found", "Pest control device not found"), 404);
    Object.assign(row, data);
    return c.json(deviceView(row));
  });
  app.get(`${ws}/site/pest/visits`, (c) => {
    const { rows, ...rest } = page(visits, c.req.query());
    return c.json({ visits: rows, ...rest });
  });
  app.post(`${ws}/site/pest/visits`, async (c) => {
    const { data, response } = await parse(c, pestVisitCreateSchema);
    if (response) return response;
    const findings = data!.findings.map((f) => {
      const d = devices.find((x) => x.id === f.deviceId);
      return {
        device: d ? { id: d.id, code: d.code, kind: d.kind, location: d.location } : null,
        location: f.location ?? null,
        activity: f.activity,
        pest: f.pest ?? null,
        count: f.count ?? null,
        note: f.note ?? null,
        action: f.action ?? null,
      };
    });
    const row = {
      id: newId(),
      contractor: data!.contractor,
      technician: data!.technician ?? null,
      visitedOn: data!.visitedOn,
      summary: data!.summary ?? null,
      recommendations: data!.recommendations ?? null,
      actionsTaken: data!.actionsTaken ?? null,
      nextVisitOn: data!.nextVisitOn ?? null,
      source: "api",
      correctedByVisitId: null,
      highestActivity: highestActivity(findings),
      findings,
    };
    visits.unshift(row);
    return c.json(row, 201);
  });

  // Glass.
  app.get(`${ws}/site/glass/items`, (c) =>
    c.json({
      items: glassItems.map((i) => ({
        ...i,
        area: areaOf(i.areaId),
        frequencyText: describeFrequency(i.checkFrequency),
        lastCheck: null,
        due: { state: "due", dueOn: null, dueAt: null },
      })),
    }),
  );
  app.post(`${ws}/site/glass/items`, async (c) => {
    const { data, response } = await parse(c, glassItemCreateSchema);
    if (response) return response;
    if (!areaOf(data!.areaId)) return c.json(err("not_found", "Area not found"), 404);
    const row = { ...data!, id: newId(), location: data!.location ?? null, status: "active" };
    glassItems.push(row);
    return c.json(
      {
        ...row,
        area: areaOf(row.areaId),
        frequencyText: describeFrequency(row.checkFrequency),
        lastCheck: null,
        due: null,
      },
      201,
    );
  });
  app.patch(`${ws}/site/glass/items/:id`, async (c) => {
    const { data, response } = await parse(c, glassItemUpdateSchema);
    if (response) return response;
    const row = glassItems.find((i) => i.id === c.req.param("id"));
    if (!row) return c.json(err("not_found", "Glass register item not found"), 404);
    Object.assign(row, data);
    return c.json({
      ...row,
      area: areaOf(row.areaId),
      frequencyText: describeFrequency(row.checkFrequency),
      lastCheck: null,
      due: null,
    });
  });
  app.get(`${ws}/site/glass/checks`, (c) => c.json({ checks: [], total: 0, limit: 50, offset: 0 }));
  app.get(`${ws}/site/glass/breakages`, (c) => {
    const q = c.req.query();
    const rows = breakages.filter((b) => q.status === "all" || !q.status || b.status === q.status);
    const p = page(rows, q);
    return c.json({ breakages: p.rows, total: p.total, limit: p.limit, offset: p.offset });
  });
  app.post(`${ws}/site/glass/breakages`, async (c) => {
    const { data, response } = await parse(c, glassBreakageCreateSchema);
    if (response) return response;
    const area = areaOf(data!.areaId);
    if (!area) return c.json(err("not_found", "Area not found"), 404);
    const row = {
      id: newId(),
      area,
      item: null,
      occurredAt: data!.occurredAt ?? now,
      description: data!.description,
      quarantined: data!.quarantined,
      cleanDown: data!.cleanDown ?? null,
      status: "open",
      releasedByName: null,
      releasedAt: null,
      source: "api",
    };
    breakages.unshift(row);
    return c.json(row, 201);
  });
  app.patch(`${ws}/site/glass/breakages/:id`, async (c) => {
    const { data, response } = await parse(c, glassBreakageUpdateSchema);
    if (response) return response;
    const row = breakages.find((b) => b.id === c.req.param("id"));
    if (!row) return c.json(err("not_found", "Glass breakage not found"), 404);
    if (row.status !== "open") return c.json(err("breakage_released", "This breakage was released"), 409);
    Object.assign(row, data);
    return c.json(row);
  });

  // Maintenance: any asset of the register, with Site's link to a calibration instrument.
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
  app.get(`${ws}/site/maintenance/assets`, (c) => c.json({ assets: assets.map(assetView) }));
  app.patch(`${ws}/site/maintenance/assets/:id`, async (c) => {
    const { data, response } = await parse(c, siteAssetUpdateSchema);
    if (response) return response;
    const row = assets.find((a) => a.id === c.req.param("id"));
    if (!row) return c.json(err("not_found", "Asset not found"), 404);
    links.set(row.id, data!.calibrationInstrumentId);
    return c.json(assetView(row));
  });
  const taskView = (t: Record<string, any>) => ({
    ...t,
    frequencyText: describeFrequency(t.frequency),
    asset: assets.find((a) => a.id === t.assetId) ?? null,
    lastRecord: null,
    due: { state: "due", dueOn: null },
  });
  app.get(`${ws}/site/maintenance/tasks`, (c) => c.json({ tasks: tasks.map(taskView) }));
  app.post(`${ws}/site/maintenance/tasks`, async (c) => {
    const { data, response } = await parse(c, maintenanceTaskCreateSchema);
    if (response) return response;
    if (!assets.some((a) => a.id === data!.assetId)) return c.json(err("not_found", "Asset not found"), 404);
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
  app.patch(`${ws}/site/maintenance/tasks/:id`, async (c) => {
    const { data, response } = await parse(c, maintenanceTaskUpdateSchema);
    if (response) return response;
    const row = tasks.find((t) => t.id === c.req.param("id"));
    if (!row) return c.json(err("not_found", "Maintenance task not found"), 404);
    Object.assign(row, data);
    return c.json(taskView(row));
  });
  app.get(`${ws}/site/maintenance/records`, (c) => c.json({ records: [], total: 0, limit: 50, offset: 0 }));

  // Work orders.
  const workOrders: Record<string, any>[] = [];
  const workOrderView = (w: Record<string, any>) => ({
    ...w,
    asset: assets.find((a) => a.id === w.assetId) ?? null,
    area: areaOf(assets.find((a) => a.id === w.assetId)?.parentAreaId),
    requestedByName: "Agent",
    assignedToName: null,
    totalCost: workOrderTotalCost(w as never),
  });
  app.get(`${ws}/site/maintenance/work-orders`, (c) => {
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
  app.post(`${ws}/site/maintenance/work-orders`, async (c) => {
    const { data, response } = await parse(c, workOrderCreateSchema);
    if (response) return response;
    if (!assets.some((a) => a.id === data!.assetId)) return c.json(err("not_found", "Asset not found"), 404);
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
  app.patch(`${ws}/site/maintenance/work-orders/:id`, async (c) => {
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

  // Pest trends.
  app.get(`${ws}/site/pest/trends`, (c) =>
    c.json({
      groupBy: c.req.query("groupBy") ?? "device",
      from: null,
      to: null,
      visits: 0,
      series: [],
    }),
  );

  // Storage.
  app.get(`${ws}/site/storage/units`, (c) => c.json({ units: units.map(unitView) }));
  app.post(`${ws}/site/storage/units`, async (c) => {
    const { data, response } = await parse(c, storageUnitCreateSchema);
    if (response) return response;
    const row = {
      ...data!,
      id: newId(),
      code: data!.code ?? null,
      location: data!.location ?? null,
      areaId: data!.areaId ?? null,
      limitMin: data!.limitMin ?? null,
      limitMax: data!.limitMax ?? null,
      unit: data!.unit ?? storageMeasureDefaultUnits[data!.measure] ?? "",
      status: "active",
    };
    units.push(row);
    return c.json(unitView(row), 201);
  });
  app.patch(`${ws}/site/storage/units/:id`, async (c) => {
    const { data, response } = await parse(c, storageUnitUpdateSchema);
    if (response) return response;
    const row = units.find((u) => u.id === c.req.param("id"));
    if (!row) return c.json(err("not_found", "Storage unit not found"), 404);
    Object.assign(row, data);
    return c.json(unitView(row));
  });
  app.get(`${ws}/site/storage/readings`, (c) => {
    const q = c.req.query();
    const rows = readings.filter(
      (r) =>
        (!q.unitId || r.unitId === q.unitId) &&
        (!q.review || r.reviewStatus === q.review) &&
        (q.outOfLimits === undefined || r.withinLimits === (q.outOfLimits === "false")),
    );
    const p = page(rows, q);
    return c.json({ readings: p.rows, total: p.total, limit: p.limit, offset: p.offset });
  });
  app.post(`${ws}/site/storage/readings`, async (c) => {
    const { data, response } = await parse(c, storageReadingCreateSchema);
    if (response) return response;
    const unit = units.find((u) => u.id === data!.unitId);
    if (!unit) return c.json(err("not_found", "Storage unit not found"), 404);
    if (unit.status === "archived") return c.json(err("unit_archived", `${unit.name} is archived`), 409);
    if (data!.checkedAt && new Date(data!.checkedAt).getTime() > Date.now() + 5 * 60_000) {
      return c.json(err("invalid_input", "A record can't be dated in the future"), 400);
    }
    const evaluation = evaluateStorageReading(
      unit as { limitMin: number | null; limitMax: number | null },
      data!.value,
    );
    const row: Record<string, any> = {
      id: newId(),
      unitId: unit.id,
      unit: { id: unit.id, code: unit.code, name: unit.name, kind: unit.kind },
      value: data!.value,
      readingText: describeStorageReading(data!.value, unit.unit),
      limitsText: describeStorageLimits({ limitMin: unit.limitMin, limitMax: unit.limitMax }, unit.unit),
      withinLimits: evaluation.withinLimits,
      deviationReason: evaluation.reason,
      checkedAt: data!.checkedAt ?? now,
      recordedByName: "Ada Lovelace",
      source: "api",
      reviewStatus: "pending",
      reviewedByName: null,
      reviewNote: null,
      note: data!.note ?? null,
      correctedByReadingId: null,
      correctiveActions: [],
    };
    readings.unshift(row);
    if (!evaluation.withinLimits) {
      const action = addAction({
        title: `${unit.name}: ${row.readingText} (limit ${row.limitsText})`,
        readingId: row.id,
        actionTaken: data!.correctiveAction?.actionTaken ?? null,
      });
      row.correctiveActions = [{ id: action.id, title: action.title, status: "open" }];
    }
    return c.json(row, 201);
  });

  // Corrective actions.
  app.get(`${ws}/site/actions`, (c) => {
    const q = c.req.query();
    const rows = actions.filter((a) => !q.status || q.status === "all" || a.status === q.status);
    const p = page(rows.map(actionView), q);
    return c.json({ actions: p.rows, total: p.total, limit: p.limit, offset: p.offset });
  });
  app.post(`${ws}/site/actions`, async (c) => {
    const { data, response } = await parse(c, siteActionCreateSchema);
    if (response) return response;
    return c.json(
      actionView(
        addAction({
          title: data!.title,
          readingId: data!.readingId ?? null,
          actionTaken: data!.actionTaken ?? null,
          rootCause: data!.rootCause ?? null,
          preventiveAction: data!.preventiveAction ?? null,
        }),
      ),
      201,
    );
  });
  app.patch(`${ws}/site/actions/:id`, async (c) => {
    const { data, response } = await parse(c, siteActionUpdateSchema);
    if (response) return response;
    const row = actions.find((a) => a.id === c.req.param("id"));
    if (!row) return c.json(err("not_found", "Corrective action not found"), 404);
    if (row.status !== "open")
      return c.json(err("site_action_closed", "This corrective action is closed"), 409);
    Object.assign(row, data);
    return c.json(actionView(row));
  });

  // Checklists.
  app.get(`${ws}/site/checklists/templates`, (c) => c.json({ templates: templates.map(templateView) }));
  app.post(`${ws}/site/checklists/templates`, async (c) => {
    const { data, response } = await parse(c, checklistTemplateCreateSchema);
    if (response) return response;
    const row = {
      id: newId(),
      name: data!.name,
      kind: data!.kind,
      areaId: data!.areaId ?? null,
      line: data!.line ?? null,
      frequency: data!.frequency ?? null,
      duringProduction: data!.duringProduction,
      status: "active",
      items: data!.items.map((i, n) => ({
        id: i.id ?? newId(),
        sortOrder: n,
        prompt: i.prompt,
        guidance: i.guidance ?? null,
      })),
    };
    templates.push(row);
    return c.json(templateView(row), 201);
  });
  app.patch(`${ws}/site/checklists/templates/:id`, async (c) => {
    const { data, response } = await parse(c, checklistTemplateUpdateSchema);
    if (response) return response;
    const row = templates.find((t) => t.id === c.req.param("id"));
    if (!row) return c.json(err("not_found", "Checklist not found"), 404);
    const { items, ...rest } = data!;
    Object.assign(row, rest);
    if (items)
      row.items = items.map((i, n) => ({
        id: i.id ?? newId(),
        sortOrder: n,
        prompt: i.prompt,
        guidance: i.guidance ?? null,
      }));
    return c.json(templateView(row));
  });
  app.get(`${ws}/site/checklists/checks`, (c) => c.json({ checks: [], total: 0, limit: 50, offset: 0 }));

  return {
    areas,
    devices,
    visits,
    units,
    templates,
    readings,
    actions,
    breakages,
    tasks,
    assets,
    glassItems,
  };
}
