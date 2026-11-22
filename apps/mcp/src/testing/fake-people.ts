import { csvImportSchema, newId, parseStaffCsv } from "@knotworking/core";
import type { Hono } from "hono";

/** In-memory stand-in for the People module's routes (apps/server/src/routes/people.ts). */
export function mountFakePeople(app: Hono, ws: string) {
  const err = (code: string, message: string) => ({ error: { code, message } });
  const now = "2026-01-05T09:00:00.000Z";
  const role = (name: string) => ({
    id: newId(),
    name,
    description: null,
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  const jobRoles: Record<string, any>[] = [role("Line operative"), role("First aider")];
  const person = (fields: Record<string, unknown>) => ({
    id: newId(),
    staffNumber: "",
    firstName: "",
    lastName: "",
    jobTitle: null,
    department: null,
    startDate: null,
    endDate: null,
    status: "active",
    payrollReference: null,
    userId: null,
    pinSetAt: null,
    pinSetBy: null,
    hasPin: false,
    pinLockedUntil: null,
    createdAt: now,
    updatedAt: now,
    jobRoleIds: [] as string[],
    ...fields,
  });
  const staff: Record<string, any>[] = [
    person({
      staffNumber: "100001",
      firstName: "Grace",
      lastName: "Hopper",
      department: "Production",
      jobRoleIds: [jobRoles[0]!.id],
      hasPin: true,
    }),
    person({ staffNumber: "000042", firstName: "Alan", lastName: "Turing", department: "Hygiene" }),
    person({
      staffNumber: "100002",
      firstName: "Kat",
      lastName: "Johnson",
      status: "leaver",
      endDate: "2026-03-31",
    }),
  ];
  const view = ({ jobRoleIds, ...s }: Record<string, any>) => ({
    ...s,
    jobRoles: jobRoles.filter((r) => jobRoleIds.includes(r.id)).map((r) => ({ id: r.id, name: r.name })),
    user: null,
  });

  app.get(`${ws}/people/staff`, (c) => {
    const q = c.req.query("q")?.toLowerCase();
    const status = c.req.query("status") ?? "active";
    const jobRoleId = c.req.query("jobRoleId");
    const department = c.req.query("department")?.toLowerCase();
    const limit = Number(c.req.query("limit") ?? 100);
    const offset = Number(c.req.query("offset") ?? 0);
    const matched = staff.filter(
      (s) =>
        (status === "all" || s.status === status) &&
        (!jobRoleId || s.jobRoleIds.includes(jobRoleId)) &&
        (!department || s.department?.toLowerCase() === department) &&
        (!q || `${s.firstName} ${s.lastName} ${s.staffNumber}`.toLowerCase().includes(q)),
    );
    return c.json({
      staff: matched.slice(offset, offset + limit).map(view),
      total: matched.length,
      limit,
      offset,
    });
  });
  app.post(`${ws}/people/staff/import`, async (c) => {
    const body = csvImportSchema.parse(await c.req.json());
    const parsed = parseStaffCsv(body.csv);
    const result = (changes: any[], unchanged: number) => ({
      dryRun: !!body.dryRun,
      fileName: null,
      rowCount: parsed.rowCount,
      ignoredColumns: parsed.ignoredColumns,
      errors: parsed.errors,
      created: changes.filter((x) => x.action === "create").length,
      updated: changes.filter((x) => x.action === "update").length,
      unchanged,
      changes,
      changesTruncated: false,
    });
    if (parsed.errors.length) {
      if (body.dryRun) return c.json(result([], 0));
      const message = `${new Set(parsed.errors.map((e) => e.row)).size} rows have problems; nothing was saved.`;
      return c.json({ error: { code: "invalid_rows", message, details: { errors: parsed.errors } } }, 400);
    }
    const changes: any[] = [];
    let unchanged = 0;
    for (const { row, staffNumber, jobRoleNames, ...fields } of parsed.entries) {
      const found = staff.find((s) => s.staffNumber === staffNumber);
      const given = Object.entries(fields).filter(([, v]) => v !== undefined);
      const roleIds = jobRoleNames?.flatMap((n) =>
        jobRoles.filter((r) => r.name.toLowerCase() === n.toLowerCase()).map((r) => r.id),
      );
      if (!found) {
        changes.push({
          row,
          action: "create",
          key: staffNumber,
          name: `${fields.firstName} ${fields.lastName}`,
          fields: [],
        });
        if (!body.dryRun)
          staff.push(person({ staffNumber, ...Object.fromEntries(given), jobRoleIds: roleIds ?? [] }));
        continue;
      }
      const changed = given.filter(([k, v]) => JSON.stringify(found[k]) !== JSON.stringify(v));
      if (!changed.length) unchanged++;
      else {
        changes.push({
          row,
          action: "update",
          key: staffNumber,
          name: `${found.firstName} ${found.lastName}`,
          fields: changed.map(([k]) => k),
        });
        if (!body.dryRun)
          Object.assign(found, Object.fromEntries(changed), roleIds ? { jobRoleIds: roleIds } : {});
      }
    }
    return c.json(result(changes, unchanged), body.dryRun ? 200 : 201);
  });
  app.get(`${ws}/people/staff/:id`, (c) => {
    const found = staff.find((s) => s.id === c.req.param("id"));
    return found ? c.json(view(found)) : c.json(err("not_found", "Staff member not found"), 404);
  });
  app.post(`${ws}/people/staff`, async (c) => {
    const body = await c.req.json();
    const staffNumber = body.staffNumber ?? String(Math.max(...staff.map((s) => Number(s.staffNumber))) + 1);
    if (staff.some((s) => s.staffNumber === staffNumber)) {
      return c.json(err("staff_number_taken", `Staff number ${staffNumber} is already in use`), 409);
    }
    const created = person({ ...body, staffNumber, jobRoleIds: body.jobRoleIds ?? [] });
    staff.push(created);
    return c.json(view(created), 201);
  });
  app.patch(`${ws}/people/staff/:id`, async (c) => {
    const found = staff.find((s) => s.id === c.req.param("id"));
    if (!found) return c.json(err("not_found", "Staff member not found"), 404);
    const body = await c.req.json();
    if (body.status === "leaver" && found.status !== "leaver" && body.endDate === undefined)
      body.endDate = "2026-01-05";
    Object.assign(found, body);
    return c.json(view(found));
  });
  app.get(`${ws}/people/job-roles`, (c) => {
    const status = c.req.query("status") ?? "active";
    return c.json({
      jobRoles: jobRoles
        .filter((r) => status === "all" || r.status === status)
        .map((r) => ({
          ...r,
          staffCount: staff.filter((s) => s.status === "active" && s.jobRoleIds.includes(r.id)).length,
        })),
    });
  });
  app.post(`${ws}/people/job-roles`, async (c) => {
    const body = await c.req.json();
    if (jobRoles.some((r) => r.name.toLowerCase() === body.name.toLowerCase())) {
      return c.json(err("name_taken", `There is already a job role called "${body.name}"`), 409);
    }
    const created = { ...role(body.name), description: body.description ?? null };
    jobRoles.push(created);
    return c.json(created, 201);
  });

  return { staff, jobRoles };
}
