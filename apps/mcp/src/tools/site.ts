import {
  checklistTemplateCreateSchema,
  checklistTemplateUpdateSchema,
  ccpLogReviewStatuses,
  checkSignOffStatuses,
  glassItemCreateSchema,
  glassItemUpdateSchema,
  maintenanceTaskCreateSchema,
  maintenanceTaskUpdateSchema,
  pestActivityLevels,
  pestTrendGroupings,
  pestDeviceCreateSchema,
  pestDeviceUpdateSchema,
  siteAssetUpdateSchema,
  siteProgrammes,
  storageUnitCreateSchema,
  storageUnitUpdateSchema,
} from "@knotworking/core";
import { z } from "zod";
import { ToolError, type Api } from "../api";
import { pickReference, type ToolContext } from "./shared";

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const CREATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const UPDATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PERSON_ONLY =
  "Reviewing (approving or rejecting) storage readings, signing off pre-start and changeover checks, releasing an area after a glass breakage, the hygiene clearance after maintenance, closing a corrective action, recording glass checks, completed maintenance and pre-start or changeover checks, and every correction are signed by people in the app; there are no tools for them, and an agent never signs off or closes its own work.";

const registerKinds = [
  "areas",
  "pest_devices",
  "glass_items",
  "maintenance_assets",
  "maintenance_tasks",
  "storage_units",
  "checklists",
] as const;
const recordKinds = [
  "pest_visits",
  "glass_checks",
  "glass_breakages",
  "maintenance_records",
  "storage_readings",
  "checklist_checks",
  "corrective_actions",
  "work_orders",
] as const;
const entryKinds = [
  "pest_device",
  "glass_item",
  "maintenance_asset",
  "maintenance_task",
  "storage_unit",
  "checklist",
] as const;

/**
 * Site programmes module (`site`). Agents read the registers, records and what is due; they may
 * keep the registers, enter a pest control service report, record storage temperature readings
 * (which wait for a person's review), report a glass breakage and raise or fill in corrective
 * actions. They never sign anything off.
 */
export function registerSiteTools({ define, slugOf, workspaceParam }: ToolContext) {
  const ws = (api: Api) => api.client.v1.workspaces[":slug"];
  const date = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe("YYYY-MM-DD");

  /** An area id from an id, or an exact area name or code (case-insensitive). */
  async function resolveArea(api: Api, slug: string, ref: string) {
    const wanted = ref.trim();
    if (UUID.test(wanted)) return wanted;
    const { areas } = await api.call(ws(api).site.areas.$get({ param: { slug } }));
    const match = areas.filter(
      (a) => a.name.toLowerCase() === wanted.toLowerCase() || a.code?.toLowerCase() === wanted.toLowerCase(),
    );
    if (match.length === 1) return match[0]!.id;
    throw new ToolError(
      "not_found",
      `No area is called "${wanted}". Use list_site_registers with kind areas to see them; areas are kept in the asset register (save_asset with kind area).`,
    );
  }

  const unitRef = async (api: Api, slug: string, ref: string) =>
    pickReference(
      (await api.call(ws(api).site.storage.units.$get({ param: { slug }, query: { status: "all" } }))).units,
      ref,
      (u) => [u.code, u.name],
      "storage unit",
      "Use list_site_registers with kind storage_units.",
    );
  const deviceRef = async (api: Api, slug: string, ref: string) =>
    pickReference(
      (await api.call(ws(api).site.pest.devices.$get({ param: { slug }, query: { status: "all" } }))).devices,
      ref,
      (d) => [d.code],
      "pest control device",
      "Use list_site_registers with kind pest_devices.",
    );
  const assetRef = async (api: Api, slug: string, ref: string) =>
    pickReference(
      (await api.call(ws(api).site.maintenance.assets.$get({ param: { slug }, query: { status: "all" } })))
        .assets,
      ref,
      (a) => [a.code, a.name],
      "asset",
      "Use list_site_registers with kind maintenance_assets.",
    );

  define(
    "get_site_due",
    {
      module: "site",
      title: "What's due (site programmes)",
      description:
        "Everything scheduled across the site programmes that is overdue or due today, most urgent first: the pest control contractor's next visit (still listed as due, with reason `no_next_visit` or `no_visit_recorded`, when no next date is set or no visit has been recorded), glass and brittle plastics checks (one line per area), planned maintenance tasks when Maintenance is readable, storage temperature readings (by each unit's frequency) and pre-start checks. `include: all` also returns what is due soon or up to date. `programme` narrows to one of: " +
        siteProgrammes.join(", ") +
        ". `counts` says what waits for a person: storage readings to review, checks to sign off, hygiene clearances to give, open glass breakages, open corrective actions, open breakdowns and work orders, damaged or missing glass, and moderate or high pest activity on the last visit. Computed from the registers and the last records; nothing is recorded.",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        include: z.enum(["due", "all"]).optional(),
        programme: z.enum(siteProgrammes).optional(),
      },
    },
    async ({ workspace, include, programme }, api) => {
      const slug = await slugOf(api, workspace);
      const due = await api.call(
        ws(api).site.due.$get({
          param: { slug },
          query: { ...(include ? { include } : {}), ...(programme ? { programme } : {}) },
        }),
      );
      return {
        today: due.today,
        counts: due.counts,
        items: due.items.map((i) => ({
          programme: i.programme,
          what: i.title,
          where: i.where,
          state: i.state,
          dueOn: i.dueOn,
          dueAt: i.dueAt,
          lastAt: i.lastAt,
          note: i.note,
          reason: i.reason ?? null,
          id: i.subjectId,
        })),
      };
    },
  );

  define(
    "list_site_registers",
    {
      module: "site",
      resource: { name: "site_registers", op: "list" },
      title: "List site registers",
      description:
        "The registers behind the site programmes. `kind`: `areas` (from the asset register; where things are), `pest_devices` (bait stations, traps and fly killers with the last activity found), `glass_items` (the glass and brittle plastics register by area, with the last condition check and when the next is due), `maintenance_assets` (assets of the register that can be maintained, with the HACCP calibration instrument each is, if linked and HACCP is readable, and where that stands), `maintenance_tasks` (what is done to each asset, how often, what is due and whether work needs a hygiene clearance), `storage_units` (chillers, freezers and ambient stores with what they measure (temperature, humidity, pressure or another measure), limits and unit, the last reading and what is due) or `checklists` (pre-start and allergen changeover checklists with their items). Archived entries are left out unless `include_archived` is true.",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        kind: z.enum(registerKinds),
        include_archived: z.boolean().optional(),
        area: z.string().min(1).max(200).optional().describe("Area name, code or id (glass_items)."),
      },
    },
    async ({ workspace, kind, include_archived, area }, api) => {
      const slug = await slugOf(api, workspace);
      const status = include_archived ? ("all" as const) : ("active" as const);
      const param = { slug };
      switch (kind) {
        case "areas":
          return (await api.call(ws(api).site.areas.$get({ param }))).areas;
        case "pest_devices": {
          const { devices } = await api.call(ws(api).site.pest.devices.$get({ param, query: { status } }));
          return devices.map((d) => ({
            id: d.id,
            code: d.code,
            kind: d.kind,
            location: d.location,
            area: d.area?.name ?? null,
            status: d.status,
            lastFinding: d.lastFinding,
          }));
        }
        case "glass_items": {
          const areaId = area ? await resolveArea(api, slug, area) : undefined;
          const { items } = await api.call(
            ws(api).site.glass.items.$get({
              param,
              query: { status: include_archived ? "all" : "active", ...(areaId ? { areaId } : {}) },
            }),
          );
          return items.map((i) => ({
            id: i.id,
            area: i.area?.name ?? null,
            kind: i.kind,
            description: i.description,
            quantity: i.quantity,
            location: i.location,
            checkFrequency: i.frequencyText,
            status: i.status,
            lastCheck: i.lastCheck,
            due: i.due ? { state: i.due.state, dueOn: i.due.dueOn } : null,
          }));
        }
        case "maintenance_assets": {
          const { assets } = await api.call(
            ws(api).site.maintenance.assets.$get({ param, query: { status } }),
          );
          return assets.map((a) => ({
            id: a.id,
            code: a.code,
            name: a.name,
            location: a.location,
            area: a.area?.name ?? null,
            status: a.status,
            calibrationInstrument: a.calibrationInstrument
              ? {
                  id: a.calibrationInstrument.id,
                  name: a.calibrationInstrument.name,
                  code: a.calibrationInstrument.code,
                  calibration: a.calibrationInstrument.state,
                  lastCalibratedAt: a.calibrationInstrument.lastCalibration?.calibratedAt ?? null,
                  lastPassed: a.calibrationInstrument.lastCalibration?.passed ?? null,
                  nextDueOn: a.calibrationInstrument.lastCalibration?.nextDueOn ?? null,
                }
              : null,
          }));
        }
        case "maintenance_tasks": {
          const { tasks } = await api.call(ws(api).site.maintenance.tasks.$get({ param, query: { status } }));
          return tasks.map((t) => ({
            id: t.id,
            asset: t.asset?.name ?? null,
            title: t.title,
            frequency: t.frequencyText,
            hygieneClearanceRequired: t.clearanceRequired,
            status: t.status,
            lastCompletedAt: t.lastRecord?.completedAt ?? null,
            due: t.due,
          }));
        }
        case "storage_units": {
          const { units } = await api.call(ws(api).site.storage.units.$get({ param, query: { status } }));
          return units.map((u) => ({
            id: u.id,
            code: u.code,
            name: u.name,
            kind: u.kind,
            measure: u.measure,
            unit: u.unit,
            location: u.location,
            limits: u.limitsText,
            frequency: u.frequencyText,
            status: u.status,
            lastReading: u.lastReading,
            due: u.due ? { state: u.due.state, dueOn: u.due.dueOn, dueAt: u.due.dueAt } : null,
          }));
        }
        case "checklists": {
          const { templates } = await api.call(
            ws(api).site.checklists.templates.$get({ param, query: { status } }),
          );
          return templates.map((t) => ({
            id: t.id,
            name: t.name,
            kind: t.kind,
            area: t.area?.name ?? null,
            line: t.line,
            frequency: t.frequencyText,
            duringProduction: t.duringProduction,
            status: t.status,
            items: t.items.map((i) => ({ id: i.id, prompt: i.prompt, guidance: i.guidance })),
            lastCheck: t.lastCheck,
            due: t.due ? { state: t.due.state, dueOn: t.due.dueOn } : null,
          }));
        }
      }
    },
  );

  define(
    "list_site_records",
    {
      module: "site",
      resource: { name: "site_records", op: "list" },
      title: "List site records",
      description:
        "Site programme records, newest first. `kind`: `pest_visits` (contractor visits with findings by device, recommendations, actions and the next visit; `problems: true` for visits with moderate or high activity), `glass_checks` (condition checks; `problems: true` for damaged or missing), `glass_breakages` (incidents: what was quarantined, the clean-down and who released the area; `status` open, released or all), `maintenance_records` (work done; `awaiting_clearance: true` for work in a production area that still needs a person's hygiene clearance), `storage_readings` (temperatures with the unit's limits, whether within limits, where it came from (`source: api` for a token or sensor) and its review status; `out_of_limits` and `review` filter; `review: pending` lists what still awaits a person's review), `checklist_checks` (completed pre-start and allergen changeover checks with every item's result, the batches before and after a changeover with the allergen risk worked out from them (`allergenRisk`: a warning only) and the sign-off; `sign_off: pending` lists what awaits sign-off) or `corrective_actions` (`status` open, closed or all; each has `missing`: what must be filled in before a person can close it) or `work_orders` (breakdowns and work requests on equipment with priority, who it is assigned to, spares and costs once done; `status` open (default: requested and in progress), completed, cancelled or all). Corrected records show `correctedBy…`. Paged: use `offset` while `hasMore` is true.",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        kind: z.enum(recordKinds),
        from: date.optional().describe("YYYY-MM-DD, inclusive."),
        to: date.optional().describe("YYYY-MM-DD, inclusive."),
        unit: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe("Storage unit id, code or name (storage_readings)."),
        problems: z
          .boolean()
          .optional()
          .describe(
            "Only damaged or missing results (glass_checks), or visits with moderate or high activity (pest_visits).",
          ),
        out_of_limits: z
          .boolean()
          .optional()
          .describe("Only out-of-limit (true) or within-limit (false) readings."),
        review: z.enum(ccpLogReviewStatuses).optional().describe("Review status (storage_readings)."),
        sign_off: z.enum(checkSignOffStatuses).optional().describe("Sign-off status (checklist_checks)."),
        awaiting_clearance: z.boolean().optional().describe("Only work awaiting a hygiene clearance."),
        status: z
          .enum(["open", "closed", "released", "completed", "cancelled", "all"])
          .optional()
          .describe("glass_breakages, corrective_actions or work_orders."),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const param = { slug };
      const paging = { limit: String(a.limit ?? 50), offset: String(a.offset ?? 0) };
      const dates = { ...(a.from ? { from: a.from } : {}), ...(a.to ? { to: a.to } : {}) };
      const pageOf = (p: { total: number; offset: number }, returned: number) => ({
        total: p.total,
        offset: p.offset,
        returned,
        hasMore: p.offset + returned < p.total,
      });
      switch (a.kind) {
        case "pest_visits": {
          const page = await api.call(
            ws(api).site.pest.visits.$get({
              param,
              query: { ...dates, ...paging, ...(a.problems ? { activity: "true" as const } : {}) },
            }),
          );
          return {
            visits: page.visits.map((v) => ({
              id: v.id,
              contractor: v.contractor,
              technician: v.technician,
              visitedOn: v.visitedOn,
              nextVisitOn: v.nextVisitOn,
              highestActivity: v.highestActivity,
              summary: v.summary,
              recommendations: v.recommendations,
              actionsTaken: v.actionsTaken,
              source: v.source,
              correctedByVisitId: v.correctedByVisitId,
              findings: v.findings.map((f) => ({
                device: f.device?.code ?? null,
                location: f.location ?? f.device?.location ?? null,
                activity: f.activity,
                pest: f.pest,
                count: f.count,
                note: f.note,
                action: f.action,
              })),
            })),
            ...pageOf(page, page.visits.length),
          };
        }
        case "glass_checks": {
          const page = await api.call(
            ws(api).site.glass.checks.$get({
              param,
              query: { ...dates, ...paging, ...(a.problems ? { problems: "true" as const } : {}) },
            }),
          );
          return {
            checks: page.checks.map((c) => ({
              id: c.id,
              area: c.area?.name ?? null,
              item: c.item?.description ?? null,
              condition: c.condition,
              note: c.note,
              checkedAt: c.checkedAt,
              recordedBy: c.recordedByName,
              correctedByCheckId: c.correctedByCheckId,
            })),
            ...pageOf(page, page.checks.length),
          };
        }
        case "glass_breakages": {
          const status = a.status === "open" || a.status === "released" ? a.status : "all";
          const page = await api.call(
            ws(api).site.glass.breakages.$get({ param, query: { status, ...paging } }),
          );
          return {
            breakages: page.breakages.map((b) => ({
              id: b.id,
              area: b.area?.name ?? null,
              item: b.item?.description ?? null,
              occurredAt: b.occurredAt,
              description: b.description,
              quarantined: b.quarantined,
              cleanDown: b.cleanDown,
              status: b.status,
              releasedBy: b.releasedByName,
              releasedAt: b.releasedAt,
              source: b.source,
            })),
            ...pageOf(page, page.breakages.length),
          };
        }
        case "maintenance_records": {
          const page = await api.call(
            ws(api).site.maintenance.records.$get({
              param,
              query: {
                ...dates,
                ...paging,
                ...(a.awaiting_clearance ? { awaitingClearance: "true" as const } : {}),
              },
            }),
          );
          return {
            records: page.records.map((r) => ({
              id: r.id,
              asset: r.asset?.name ?? null,
              task: r.task?.title ?? null,
              area: r.area?.name ?? null,
              completedAt: r.completedAt,
              doneBy: r.doneByName,
              contractor: r.contractor,
              workDone: r.workDone,
              nextDueOn: r.nextDueOn,
              hygieneClearanceRequired: r.clearanceRequired,
              clearedBy: r.clearedByName,
              clearedAt: r.clearedAt,
              awaitingClearance: r.awaitingClearance,
              correctedByRecordId: r.correctedByRecordId,
            })),
            ...pageOf(page, page.records.length),
          };
        }
        case "storage_readings": {
          const unitId = a.unit ? await unitRef(api, slug, a.unit) : undefined;
          const page = await api.call(
            ws(api).site.storage.readings.$get({
              param,
              query: {
                ...dates,
                ...paging,
                ...(unitId ? { unitId } : {}),
                ...(a.out_of_limits !== undefined
                  ? { outOfLimits: String(a.out_of_limits) as "true" | "false" }
                  : {}),
                ...(a.review ? { review: a.review } : {}),
                // A corrected pending reading no longer awaits review: the correction replaced it.
                ...(a.review === "pending" ? { includeCorrected: "false" as const } : {}),
              },
            }),
          );
          return {
            readings: page.readings.map((r) => ({
              id: r.id,
              unit: r.unit?.name ?? null,
              reading: r.readingText,
              limits: r.limitsText,
              withinLimits: r.withinLimits,
              deviationReason: r.deviationReason,
              checkedAt: r.checkedAt,
              recordedBy: r.recordedByName,
              source: r.source,
              reviewStatus: r.reviewStatus,
              reviewedBy: r.reviewedByName,
              reviewNote: r.reviewNote,
              note: r.note,
              correctedByReadingId: r.correctedByReadingId,
              correctiveActions: r.correctiveActions,
            })),
            ...pageOf(page, page.readings.length),
          };
        }
        case "checklist_checks": {
          const page = await api.call(
            ws(api).site.checklists.checks.$get({
              param,
              query: {
                ...dates,
                ...paging,
                // A corrected check can't be signed off, so the queue leaves it out.
                ...(a.sign_off ? { signOff: a.sign_off } : {}),
                ...(a.sign_off === "pending" ? { includeCorrected: "false" } : {}),
              },
            }),
          );
          return {
            checks: page.checks.map((c) => ({
              id: c.id,
              checklist: c.templateName,
              allergenRisk: c.allergenRisk
                ? { status: c.allergenRisk.status, warnings: c.allergenRisk.warnings }
                : null,
              kind: c.kind,
              area: c.area?.name ?? null,
              line: c.line,
              performedAt: c.performedAt,
              performedBy: c.performedByName,
              outcome: c.outcome,
              failedItems: c.results
                .filter((r) => r.result === "fail")
                .map((r) => ({ item: r.prompt, note: r.note })),
              previousBatch: c.previousBatch?.batchCode ?? null,
              nextBatch: c.nextBatch?.batchCode ?? null,
              signOff: c.signOffStatus,
              signedOffBy: c.signedOffByName,
              signOffNote: c.signOffNote,
              note: c.note,
              correctedByCheckId: c.correctedByCheckId,
            })),
            ...pageOf(page, page.checks.length),
          };
        }
        case "work_orders": {
          const status =
            a.status === "completed" || a.status === "cancelled" || a.status === "all" ? a.status : "open";
          const page = await api.call(
            ws(api).site.maintenance["work-orders"].$get({ param, query: { status, ...paging } }),
          );
          return {
            workOrders: page.workOrders.map((w) => ({
              id: w.id,
              kind: w.kind,
              title: w.title,
              asset: w.asset?.name ?? null,
              area: w.area?.name ?? null,
              priority: w.priority,
              stopsProduction: w.stopsProduction,
              status: w.status,
              requestedBy: w.requestedByName,
              assignedTo: w.assignedToName,
              contractor: w.contractor,
              description: w.description,
              workDone: w.workDone,
              sparesUsed: w.sparesUsed,
              partsCost: w.partsCost,
              labourCost: w.labourCost,
              contractorCost: w.contractorCost,
              totalCost: w.totalCost,
              downtimeMinutes: w.downtimeMinutes,
              completedAt: w.completedAt,
              source: w.source,
            })),
            ...pageOf(page, page.workOrders.length),
          };
        }
        case "corrective_actions": {
          const status = a.status === "open" || a.status === "closed" ? a.status : "all";
          const page = await api.call(ws(api).site.actions.$get({ param, query: { status, ...paging } }));
          return {
            actions: page.actions.map((c) => ({
              id: c.id,
              title: c.title,
              status: c.status,
              reading: c.reading,
              actionTaken: c.actionTaken,
              rootCause: c.rootCause,
              preventiveAction: c.preventiveAction,
              missing: c.missing,
              source: c.source,
              raisedBy: c.raisedByName,
              closedBy: c.closedByName,
              closedAt: c.closedAt,
              closureNote: c.closureNote,
            })),
            ...pageOf(page, page.actions.length),
          };
        }
      }
    },
  );

  define(
    "record_pest_visit",
    {
      module: "site",
      title: "Record a pest control visit",
      description:
        "Enter a pest control contractor's service report: the contractor, the visit date, the findings (for each device its code and the activity found: none, low, moderate or high, with the pest and count; or a place with no device), the contractor's recommendations, actions taken and the date of the next visit (this sets what is due). Devices are given by code (see list_site_registers, kind pest_devices). Recorded as coming from the API. Only enter what a real report says. Correcting a visit is a person's act in the app. " +
        PERSON_ONLY,
      annotations: CREATE,
      input: {
        workspace: workspaceParam,
        contractor: z.string().min(1).max(200),
        technician: z.string().max(200).optional(),
        visited_on: date.describe("The visit date, YYYY-MM-DD; not in the future."),
        summary: z.string().max(4000).optional(),
        recommendations: z.string().max(4000).optional(),
        actions_taken: z.string().max(4000).optional(),
        next_visit_on: date.optional().describe("When the contractor is next due."),
        findings: z
          .array(
            z.object({
              device: z.string().min(1).max(200).optional().describe("Device code or id."),
              location: z.string().max(200).optional().describe("Where, for a finding with no device."),
              activity: z.enum(pestActivityLevels),
              pest: z.string().max(100).optional().describe("What was found; needed when there is activity."),
              count: z.number().int().min(0).max(100000).optional(),
              note: z.string().max(1000).optional(),
              action: z.string().max(1000).optional().describe("What was done about it."),
            }),
          )
          .max(300)
          .optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const findings = [];
      for (const f of a.findings ?? []) {
        findings.push({
          ...(f.device ? { deviceId: await deviceRef(api, slug, f.device) } : {}),
          ...(f.location ? { location: f.location } : {}),
          activity: f.activity,
          ...(f.pest ? { pest: f.pest } : {}),
          ...(f.count !== undefined ? { count: f.count } : {}),
          ...(f.note ? { note: f.note } : {}),
          ...(f.action ? { action: f.action } : {}),
        });
      }
      const visit = await api.call(
        ws(api).site.pest.visits.$post({
          param: { slug },
          json: {
            contractor: a.contractor,
            ...(a.technician ? { technician: a.technician } : {}),
            visitedOn: a.visited_on,
            ...(a.summary ? { summary: a.summary } : {}),
            ...(a.recommendations ? { recommendations: a.recommendations } : {}),
            ...(a.actions_taken ? { actionsTaken: a.actions_taken } : {}),
            ...(a.next_visit_on ? { nextVisitOn: a.next_visit_on } : {}),
            findings,
          },
        }),
      );
      return {
        id: visit.id,
        contractor: visit.contractor,
        visitedOn: visit.visitedOn,
        nextVisitOn: visit.nextVisitOn,
        highestActivity: visit.highestActivity,
        findings: visit.findings.length,
        note: "Recorded as coming from the API. A person corrects a visit in the app if it is wrong.",
      };
    },
  );

  define(
    "record_storage_readings",
    {
      module: "site",
      title: "Record storage temperature readings",
      description:
        "Record temperature readings of storage units (up to 50): for each, the unit (id, code or name) and the value in the unit's measure (usually °C), optionally when it was read and a note. Each reading is checked against the unit's limits at once and the result says whether it was within limits. An out-of-limit reading opens a corrective action straight away (returned with the reading): fill it in with propose_site_action, or pass `action_taken` with the reading. Readings recorded here are marked as coming from the API and are NOT approved: they await review by a person with manage access in the app. Until then they count as done for what's due; a rejected one makes the reading due again. Each reading is recorded on its own: if one fails the others still go in, and the result says which failed and why. Never record a reading you did not get from a real measurement or a person's report. " +
        PERSON_ONLY,
      annotations: CREATE,
      input: {
        workspace: workspaceParam,
        readings: z
          .array(
            z.object({
              unit: z.string().min(1).max(200).describe("Storage unit id, code or name."),
              value: z.number(),
              checked_at: z
                .string()
                .datetime({ offset: true })
                .optional()
                .describe("When it was read (ISO 8601 with an offset). Default: now; never in the future."),
              note: z.string().max(1000).optional(),
              action_taken: z
                .string()
                .max(4000)
                .optional()
                .describe("What was done at once, if out of limits."),
            }),
          )
          .min(1)
          .max(50),
      },
    },
    async ({ workspace, readings }, api) => {
      const slug = await slugOf(api, workspace);
      const resolved = new Map<string, string>();
      // Resolve every unit before anything is written.
      for (const r of readings) {
        if (!resolved.has(r.unit)) resolved.set(r.unit, await unitRef(api, slug, r.unit));
      }
      const results = [];
      for (const r of readings) {
        try {
          const reading = await api.call(
            ws(api).site.storage.readings.$post({
              param: { slug },
              json: {
                unitId: resolved.get(r.unit)!,
                value: r.value,
                ...(r.checked_at ? { checkedAt: r.checked_at } : {}),
                ...(r.note ? { note: r.note } : {}),
                ...(r.action_taken ? { correctiveAction: { actionTaken: r.action_taken } } : {}),
              },
            }),
          );
          results.push({
            recorded: true,
            id: reading.id,
            unit: reading.unit?.name ?? r.unit,
            reading: reading.readingText,
            limits: reading.limitsText,
            withinLimits: reading.withinLimits,
            deviationReason: reading.deviationReason,
            checkedAt: reading.checkedAt,
            reviewStatus: reading.reviewStatus,
            correctiveAction: reading.correctiveActions[0] ?? null,
          });
        } catch (e) {
          // A reading the API refuses (archived unit, dated in the future) is reported with the
          // others; access and availability errors stop the call.
          if (!(e instanceof ToolError) || ![400, 404, 409].includes(e.options.status ?? 0)) throw e;
          results.push({ recorded: false, unit: r.unit, error: { code: e.code, message: e.message } });
        }
      }
      const recorded = results.filter((r) => r.recorded);
      return {
        recorded: recorded.length,
        failed: results.length - recorded.length,
        outOfLimits: recorded.filter((r) => "withinLimits" in r && !r.withinLimits).length,
        readings: results,
        note: "These readings await review by a person with manage access in the app. Out-of-limit readings have an open corrective action already: fill it in with propose_site_action.",
      };
    },
  );

  const entryDocs = {
    pest_device:
      "kind (rodent_bait_station, rodent_trap, insect_electric_fly_killer, pheromone_trap, other), code, location, area",
    glass_item:
      "area, kind (glass, brittle_plastic, ceramic, other), description, quantity, location, checkFrequency {every, unit: hour|day|week|month} (default monthly); update also status active|removed",
    maintenance_asset:
      "update only (`id` of an asset of the register): calibrationInstrumentId (the HACCP calibration register equipment this asset is, or null; a reference, read-only there; needs HACCP). The asset itself is added and changed with save_asset",
    maintenance_task:
      "asset (id, code or name), title, description, frequency {every, unit}, startOn (first due date), clearanceRequired (work in a production area needs a person's hygiene clearance; the asset needs an area)",
    storage_unit:
      "code, name, kind (chiller, freezer, ambient, other), measure (temperature (default), humidity, pressure, other; fixed once it has readings), location, area, limitMin, limitMax (at least one; humidity 0 to 100), unit (default °C, %RH or Pa by measure; `other` needs one), readingFrequency {every, unit} (default daily)",
    checklist:
      "name, kind (prestart or allergen_changeover), area, line, frequency {every, unit} (none for a check done when needed), duringProduction, items [{id?, prompt, guidance?}] (sending items replaces the list; keep an item's id to keep its history)",
  } as const;

  define(
    "save_site_register_entry",
    {
      module: "site",
      title: "Create or update a site register entry",
      description:
        "Create (or, with `id`, update) an entry in one of the site registers. `kind` and the fields of `entry`: " +
        entryKinds.map((k) => `${k}: ${entryDocs[k]}`).join(". ") +
        ". Name an area by `area` (its name, code or id); areas and maintained equipment themselves are kept in the asset register (save_asset). To archive an entry on update send `status: archived` (glass items: `removed`). Codes must be unique. Entries are validated exactly like in the app. Check with list_site_registers first so you don't create a duplicate.",
      annotations: UPDATE,
      input: {
        workspace: workspaceParam,
        kind: z.enum(entryKinds),
        id: z.string().uuid().optional().describe("Id of the entry to update; omit to create one."),
        entry: z
          .record(z.string(), z.unknown())
          .describe("The fields to set (see the description for each kind)."),
      },
    },
    async ({ workspace, kind, id, entry }, api) => {
      const slug = await slugOf(api, workspace);
      if (kind === "maintenance_asset" && !id) {
        throw new ToolError(
          "invalid_input",
          "Assets are added to the asset register with save_asset; here you only link one (by `id`) to its HACCP calibration instrument.",
        );
      }
      const body: Record<string, unknown> = { ...entry };
      if (typeof body.area === "string") {
        body.areaId = await resolveArea(api, slug, body.area);
        delete body.area;
      }
      if (typeof body.asset === "string") {
        body.assetId = await assetRef(api, slug, body.asset);
        delete body.asset;
      }
      const schemas = {
        pest_device: [pestDeviceCreateSchema, pestDeviceUpdateSchema],
        glass_item: [glassItemCreateSchema, glassItemUpdateSchema],
        maintenance_asset: [siteAssetUpdateSchema, siteAssetUpdateSchema],
        maintenance_task: [maintenanceTaskCreateSchema, maintenanceTaskUpdateSchema],
        storage_unit: [storageUnitCreateSchema, storageUnitUpdateSchema],
        checklist: [checklistTemplateCreateSchema, checklistTemplateUpdateSchema],
      } as const;
      const parsed = schemas[kind][id ? 1 : 0].safeParse(body);
      if (!parsed.success) {
        throw new ToolError(
          "invalid_input",
          `entry: ${parsed.error.issues.map((i) => `${i.path.join(".") || "entry"}: ${i.message}`).join("; ")}. Fields for ${kind}: ${entryDocs[kind]}.`,
        );
      }
      const json = body as never;
      const param = { slug };
      const call = async () => {
        switch (kind) {
          case "pest_device":
            return id
              ? api.call(ws(api).site.pest.devices[":id"].$patch({ param: { slug, id }, json }))
              : api.call(ws(api).site.pest.devices.$post({ param, json }));
          case "glass_item":
            return id
              ? api.call(ws(api).site.glass.items[":id"].$patch({ param: { slug, id }, json }))
              : api.call(ws(api).site.glass.items.$post({ param, json }));
          case "maintenance_asset":
            return api.call(
              ws(api).site.maintenance.assets[":id"].$patch({ param: { slug, id: id! }, json }),
            );
          case "maintenance_task":
            return id
              ? api.call(ws(api).site.maintenance.tasks[":id"].$patch({ param: { slug, id }, json }))
              : api.call(ws(api).site.maintenance.tasks.$post({ param, json }));
          case "storage_unit":
            return id
              ? api.call(ws(api).site.storage.units[":id"].$patch({ param: { slug, id }, json }))
              : api.call(ws(api).site.storage.units.$post({ param, json }));
          case "checklist":
            return id
              ? api.call(ws(api).site.checklists.templates[":id"].$patch({ param: { slug, id }, json }))
              : api.call(ws(api).site.checklists.templates.$post({ param, json }));
        }
      };
      const saved = (await call()) as { id: string; status?: string } & Record<string, unknown>;
      return {
        created: !id,
        kind,
        id: saved.id,
        name: (saved.name ?? saved.title ?? saved.code ?? saved.description ?? null) as string | null,
        status: saved.status ?? null,
      };
    },
  );

  define(
    "report_glass_breakage",
    {
      module: "site",
      title: "Report a glass breakage",
      description:
        "Report a glass or brittle plastics breakage, or (with `breakage`, its id) add to an open one. A report holds the area from the moment it is raised: give the area, what broke, and what was quarantined (product, packaging, equipment). Add the `clean_down` that was done when it is recorded. Releasing the area is a person's sign-off in the app and needs the clean-down recorded first; a released breakage never changes. Recorded as coming from the API. " +
        PERSON_ONLY,
      annotations: UPDATE,
      input: {
        workspace: workspaceParam,
        breakage: z.string().uuid().optional().describe("Id of an open breakage to update."),
        area: z.string().min(1).max(200).optional().describe("Area name, code or id (new reports)."),
        item: z
          .string()
          .uuid()
          .optional()
          .describe("Id of the register item that broke, if known (new reports)."),
        occurred_at: z
          .string()
          .datetime({ offset: true })
          .optional()
          .describe("When it happened; default now."),
        description: z
          .string()
          .min(1)
          .max(2000)
          .optional()
          .describe("What broke and how. Required for a new report."),
        quarantined: z
          .string()
          .min(1)
          .max(2000)
          .optional()
          .describe("What was quarantined. Required for a new report."),
        clean_down: z.string().min(1).max(2000).optional().describe("The clean-down done."),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const view = (b: {
        id: string;
        status: string;
        cleanDown: string | null;
        area: { name: string } | null;
      }) => ({
        id: b.id,
        area: b.area?.name ?? null,
        status: b.status,
        cleanDownRecorded: !!b.cleanDown,
        note: "A person with manage access releases the area in the app once the clean-down is recorded.",
      });
      if (a.breakage) {
        if (a.area || a.item || a.occurred_at) {
          throw new ToolError(
            "invalid_input",
            "The area, item and time are fixed when a breakage is reported.",
          );
        }
        const updated = await api.call(
          ws(api).site.glass.breakages[":id"].$patch({
            param: { slug, id: a.breakage },
            json: {
              ...(a.description ? { description: a.description } : {}),
              ...(a.quarantined ? { quarantined: a.quarantined } : {}),
              ...(a.clean_down ? { cleanDown: a.clean_down } : {}),
            },
          }),
        );
        return view(updated);
      }
      if (!a.area || !a.description || !a.quarantined) {
        throw new ToolError("invalid_input", "Give the `area`, a `description` and what was `quarantined`.");
      }
      const created = await api.call(
        ws(api).site.glass.breakages.$post({
          param: { slug },
          json: {
            areaId: await resolveArea(api, slug, a.area),
            ...(a.item ? { itemId: a.item } : {}),
            ...(a.occurred_at ? { occurredAt: a.occurred_at } : {}),
            description: a.description,
            quarantined: a.quarantined,
            ...(a.clean_down ? { cleanDown: a.clean_down } : {}),
          },
        }),
      );
      return view(created);
    },
  );

  define(
    "get_pest_trends",
    {
      module: "site",
      title: "Pest sightings over time",
      description:
        "Pest sightings over time from the contractor's visits (visits a correction replaced are left out), grouped by `device` (default), `area` or `pest`: for each group the sightings, findings and highest activity on each visit date, the total, and whether the last visit was up or down on the one before. Counts are the findings' counts (one for activity with no count); a device that was checked and clear shows zero.",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        group_by: z.enum(pestTrendGroupings).optional(),
        from: date.optional().describe("YYYY-MM-DD, inclusive."),
        to: date.optional().describe("YYYY-MM-DD, inclusive."),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      return api.call(
        ws(api).site.pest.trends.$get({
          param: { slug },
          query: {
            ...(a.group_by ? { groupBy: a.group_by } : {}),
            ...(a.from ? { from: a.from } : {}),
            ...(a.to ? { to: a.to } : {}),
          },
        }),
      );
    },
  );

  define(
    "propose_site_action",
    {
      module: "site",
      title: "Propose a site corrective action",
      description: `Raise a corrective action, or fill in an open one (pass \`corrective_action\`, its id): what was done, the root cause and the preventive action. Out-of-limit storage readings already have one: find it with list_site_records (kind corrective_actions) and fill it in rather than raising another. Actions raised here are marked as coming from the API. Closing it is the sign-off of a person with manage access in the app. ${PERSON_ONLY}`,
      annotations: UPDATE,
      input: {
        workspace: workspaceParam,
        corrective_action: z
          .string()
          .uuid()
          .optional()
          .describe("Id of an open corrective action to update."),
        title: z.string().min(1).max(200).optional().describe("Required when raising a new one."),
        reading: z
          .string()
          .uuid()
          .optional()
          .describe("Id of the out-of-limit storage reading it answers (new ones)."),
        action_taken: z.string().max(4000).nullable().optional(),
        root_cause: z.string().max(4000).nullable().optional(),
        preventive_action: z.string().max(4000).nullable().optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const fields = {
        ...(a.action_taken !== undefined ? { actionTaken: a.action_taken } : {}),
        ...(a.root_cause !== undefined ? { rootCause: a.root_cause } : {}),
        ...(a.preventive_action !== undefined ? { preventiveAction: a.preventive_action } : {}),
      };
      const view = (ca: { id: string; title: string; status: string; missing: string[] }) => ({
        id: ca.id,
        title: ca.title,
        status: ca.status,
        missing: ca.missing,
        note: "A person with manage access closes it in the app once action, root cause and prevention are recorded.",
      });
      if (a.corrective_action) {
        if (a.reading) {
          throw new ToolError("invalid_input", "`reading` is fixed when a corrective action is raised.");
        }
        return view(
          await api.call(
            ws(api).site.actions[":id"].$patch({
              param: { slug, id: a.corrective_action },
              json: { ...fields, ...(a.title ? { title: a.title } : {}) },
            }),
          ),
        );
      }
      if (!a.title) throw new ToolError("invalid_input", "Give a `title` to raise a corrective action.");
      return view(
        await api.call(
          ws(api).site.actions.$post({
            param: { slug },
            json: { title: a.title, ...(a.reading ? { readingId: a.reading } : {}), ...fields },
          }),
        ),
      );
    },
  );
}
