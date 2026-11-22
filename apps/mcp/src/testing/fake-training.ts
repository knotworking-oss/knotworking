import { newId } from "@knotworking/core";
import type { Hono } from "hono";
import type { mountFakePeople } from "./fake-people";

/** In-memory stand-in for the Training module's routes (apps/server/src/routes/training.ts). */
export function mountFakeTraining(app: Hono, ws: string, people: ReturnType<typeof mountFakePeople>) {
  const err = (code: string, message: string) => ({ error: { code, message } });
  const now = "2026-01-05T09:00:00.000Z";
  const today = "2026-01-05";
  const course = (fields: Record<string, unknown>) => ({
    id: newId(),
    code: "",
    title: "",
    description: null,
    kind: "induction",
    sopId: null,
    validityMonths: null,
    requiresSignOff: true,
    status: "active",
    createdAt: now,
    updatedAt: now,
    sop: null,
    requirements: [] as unknown[],
    recordCount: 0,
    ...fields,
  });
  const courses: Record<string, any>[] = [
    course({
      code: "HYG-01",
      title: "Handwashing",
      kind: "sop",
      sopId: newId(),
      validityMonths: 12,
      sop: { id: newId(), code: "SOP-HW", title: "Handwashing", currentVersion: 2 },
      requirements: [{ jobRoleId: people.jobRoles[0]!.id, jobRoleName: "Line operative", dueWithinDays: 7 }],
    }),
    course({ code: "IND-01", title: "Site induction", requiresSignOff: false }),
    course({ code: "OLD-01", title: "Old course", status: "archived" }),
  ];
  const records: Record<string, any>[] = [];
  const grace = people.staff[0]!;
  const who = (s: Record<string, any>) => ({
    id: s.id,
    staffNumber: s.staffNumber,
    firstName: s.firstName,
    lastName: s.lastName,
  });
  const column = (c: Record<string, any>) => ({
    id: c.id,
    code: c.code,
    title: c.title,
    kind: c.kind,
    status: c.status,
    validityMonths: c.validityMonths,
    requiresSignOff: c.requiresSignOff,
  });
  const missing = {
    status: "missing",
    required: true,
    completedOn: null,
    expiresOn: null,
    dueOn: "2026-01-12",
    overdue: false,
  };

  app.get(`${ws}/training/courses`, (c) => {
    const status = c.req.query("status") ?? "active";
    return c.json({ courses: courses.filter((x) => status === "all" || x.status === status) });
  });
  app.get(`${ws}/training/matrix`, (c) => {
    const courseId = c.req.query("courseId");
    const shown = courses.filter((x) => x.code === "HYG-01" && (!courseId || x.id === courseId));
    return c.json({
      today,
      courses: shown.map(column),
      rows: [
        {
          staff: {
            ...who(grace),
            department: grace.department,
            jobRoles: [{ id: people.jobRoles[0]!.id, name: "Line operative" }],
          },
          cells: Object.fromEntries(shown.map((x) => [x.id, missing])),
        },
      ],
      summary: {
        current: 0,
        expiring: 0,
        expired: 0,
        outdated: 0,
        pending_sign_off: 0,
        missing: shown.length,
      },
    });
  });
  app.get(`${ws}/training/due`, (c) =>
    c.json({
      today,
      withinDays: Number(c.req.query("withinDays") ?? 30),
      items: [
        { staff: { ...who(grace), department: grace.department }, course: column(courses[0]!), ...missing },
      ],
    }),
  );
  app.get(`${ws}/training/staff/:staffId`, (c) => {
    const person = people.staff.find((s) => s.id === c.req.param("staffId"));
    if (!person) return c.json(err("not_found", "Staff member not found"), 404);
    return c.json({
      today,
      staff: {
        ...who(person),
        department: person.department,
        startDate: null,
        status: person.status,
        jobRoles: [],
      },
      standings: [{ course: column(courses[0]!), ...missing }],
      records: records.filter((r) => r.staff.id === person.id),
    });
  });
  app.post(`${ws}/training/records`, async (c) => {
    const body = await c.req.json();
    const target = courses.find((x) => x.id === body.courseId);
    if (!target) return c.json(err("not_found", "Course not found"), 404);
    if (body.completedOn > today)
      return c.json(err("invalid_input", "Training can't be recorded for a future date"), 400);
    const created = body.staffIds.map((staffId: string) => {
      const person = people.staff.find((s) => s.id === staffId)!;
      return {
        id: newId(),
        staffId,
        courseId: target.id,
        completedOn: body.completedOn,
        outcome: body.outcome ?? "competent",
        expiresOn: target.validityMonths ? "2027-01-05" : null,
        trainerName: body.trainerName ?? null,
        notes: body.notes ?? null,
        staff: who(person),
        course: {
          id: target.id,
          code: target.code,
          title: target.title,
          requiresSignOff: target.requiresSignOff,
        },
        sopVersionNumber: target.kind === "sop" ? 2 : null,
        trainer: body.trainerName ?? null,
        signedOffAt: null,
        signedOffByName: null,
        voidedAt: null,
        voidedByName: null,
        voidReason: null,
      };
    });
    records.push(...created);
    return c.json({ records: created }, 201);
  });

  return { courses, records };
}
