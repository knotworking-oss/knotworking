import { addDays, addMonthsIso, DEFAULT_TIME_ZONE, isoWeekday, newId, todayInZone } from "@knotworking/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type Res, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";
const today = todayInZone(DEFAULT_TIME_ZONE);
const monday = addDays(today, 7 + ((7 - isoWeekday(today)) % 7));
const day = (n: number) => addDays(monday, n);

/**
 * Section 3.4.4 acceptance: show a shift shortfall for a required competence. One early shift on
 * Line 1 needs two allergen-trained line operatives every day, and a first aider whenever
 * production is planned. Four people are rostered; only one fully qualifies.
 */
describe("3.4.4.3 competence-based staffing", () => {
  let ctx: TestCtx, owner: string, member: string, memberId: string, token: string;
  let operative: string, allergen: string, firstAid: string, line: string, early: any, office: any;
  let ann: string, ben: string, cal: string, dee: string;
  let operatives: any, firstAider: any;
  const call = (method: string, path: string, json?: unknown, cookie = owner) =>
    ctx.req(WS + path, { method, cookie, json });
  const ok = async (input: Promise<Res> | Res, status = 200) => {
    const r = await input;
    const b = await r.json();
    expect(r.status, JSON.stringify(b)).toBe(status);
    return b;
  };
  const code = async (input: Promise<Res> | Res, status = 409) => (await ok(input, status)).error.code;
  const grant = (module: string, level: string | null) =>
    ok(call("PUT", `/members/${memberId}/module-access/${module}`, { level }));
  const person = async (firstName: string, roles: string[] = []) =>
    (await ok(call("POST", "/people/staff", { firstName, lastName: "Staffing", jobRoleIds: roles }), 201))
      .id as string;
  const train = async (courseId: string, staffIds: string[], completedOn: string, signOff = true) => {
    const { records } = await ok(
      call("POST", "/training/records", { courseId, staffIds, completedOn, trainerName: "Trainer" }),
      201,
    );
    if (signOff)
      await ok(call("POST", "/training/records/sign-off", { recordIds: records.map((r: any) => r.id) }));
  };
  const roster = (staffId: string, workDate: string) =>
    ok(
      call("POST", "/workforce/rota/entries", { commandId: newId(), shiftId: early.id, staffId, workDate }),
      201,
    );
  const check = (from: string, to = from, cookie = owner) =>
    ok(call("GET", `/workforce/staffing?from=${from}&to=${to}`, undefined, cookie));
  const slot = (result: any, date: string, shiftId = early.id) =>
    result.shifts.find((s: any) => s.date === date && s.shift.id === shiftId);
  const req = (result: any, date: string, id: string) =>
    slot(result, date).requirements.find((r: any) => r.requirementId === id);

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    owner = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    member = (await signIn(ctx, "marcus@knotworking.dev")).cookie;
    memberId = (await ok(ctx.req("/v1/me", { cookie: member }))).user.id;
    token = (
      await ok(
        ctx.req("/v1/me/api-tokens", {
          cookie: owner,
          method: "POST",
          json: { name: "Planner", scope: "read" },
        }),
        201,
      )
    ).token;
    operative = (await ok(call("POST", "/people/job-roles", { name: "Line operative" }), 201)).id;
    const course = async (code: string, title: string) =>
      (
        await ok(
          call("POST", "/training/courses", { code, title, kind: "induction", validityMonths: 12 }),
          201,
        )
      ).id as string;
    allergen = await course("ALG", "Allergen awareness");
    firstAid = await course("FA", "First aid at work");
    line = (await ok(call("POST", "/production/lines", { name: "Line 1", hoursPerDay: 8 }), 201)).id;
    early = await ok(
      call("POST", "/workforce/shifts", {
        commandId: newId(),
        name: "Early",
        startTime: "06:00",
        endTime: "14:00",
        lineId: line,
      }),
      201,
    );
    office = await ok(
      call("POST", "/workforce/shifts", {
        commandId: newId(),
        name: "Office",
        startTime: "09:00",
        endTime: "17:00",
      }),
      201,
    );
    ann = await person("Ann", [operative]); // qualifies
    ben = await person("Ben", [operative]); // allergen training lapses before the shift
    cal = await person("Cal"); // agency worker, no role or training
    dee = await person("Dee", [operative]); // trained, awaiting sign-off
    await train(allergen, [ann], today);
    await train(allergen, [ben], addDays(addMonthsIso(today, -12), 3));
    await train(allergen, [dee], today, false);
    const agency = await ok(
      call("POST", "/workforce/agencies", { commandId: newId(), name: "Staffline" }),
      201,
    );
    await ok(
      call("POST", "/workforce/agency-engagements", {
        commandId: newId(),
        agencyId: agency.id,
        staffId: cal,
        startOn: today,
        reference: "SL-1",
      }),
      201,
    );
    for (const p of [ann, ben, cal, dee]) await roster(p, day(0));
  }, 120_000);
  afterAll(() => ctx?.handle.close());

  it("validates requirements against shifts, roles, courses and production lines", async () => {
    const base = {
      commandId: newId(),
      shiftId: office.id,
      name: "X",
      headcount: 1,
      courseIds: [allergen],
      validFrom: monday,
    };
    expect(
      await code(
        call("POST", "/workforce/staffing/requirements", { ...base, appliesWhen: "production_planned" }),
      ),
    ).toBe("workforce_conflict");
    expect(
      await code(
        call("POST", "/workforce/staffing/requirements", {
          ...base,
          commandId: newId(),
          courseIds: [newId()],
        }),
        404,
      ),
    ).toBe("not_found");
    operatives = await ok(
      call("POST", "/workforce/staffing/requirements", {
        commandId: newId(),
        shiftId: early.id,
        name: "Allergen-trained operatives",
        headcount: 2,
        jobRoleId: operative,
        courseIds: [allergen],
        validFrom: monday,
      }),
      201,
    );
    firstAider = await ok(
      call("POST", "/workforce/staffing/requirements", {
        commandId: newId(),
        shiftId: early.id,
        name: "First aider",
        headcount: 1,
        courseIds: [firstAid],
        appliesWhen: "production_planned",
        validFrom: monday,
      }),
      201,
    );
    const listed = await ok(call("GET", "/workforce/staffing/requirements"));
    expect(listed.requirements.find((r: any) => r.id === operatives.id).courses[0]).toMatchObject({
      code: "ALG",
    });
  });

  it("shows the shortfall for a required competence and why each rostered person doesn't count", async () => {
    const result = await check(day(0));
    expect(result).toMatchObject({ absenceSourceEnabled: true, trainingSourceEnabled: true });
    const r = req(result, day(0), operatives.id);
    expect(r).toMatchObject({ applies: true, headcount: 2, counted: [ann], shortfall: 1 });
    const why = Object.fromEntries(
      r.excluded.map((e: any) => [e.staffId, e.reasons.map((x: any) => x.reason)]),
    );
    expect(why).toEqual({
      [ben]: ["training_expires_before_shift"],
      [cal]: ["role_not_held", "training_missing"],
      [dee]: ["training_awaiting_sign_off"],
    });
    expect(r.excluded.find((e: any) => e.staffId === ben).reasons[0].expiresOn).toBe(
      addMonthsIso(addDays(addMonthsIso(today, -12), 3), 12),
    );
    expect(slot(result, day(0)).people.find((p: any) => p.staff.id === cal).agency).toMatchObject({
      name: "Staffline",
    });
    // No batch is planned on Line 1, so the first-aider requirement doesn't apply.
    expect(req(result, day(0), firstAider.id)).toMatchObject({
      applies: false,
      reason: "no_production_planned",
      shortfall: 0,
    });
    expect(result.summary).toEqual({ requirementsChecked: 1, shortfalls: 1, unfilledPositions: 1 });
  });

  it("applies production-linked requirements only when production is planned on a working day", async () => {
    const item = async (body: object) => (await ok(call("POST", "/items", body), 201)).id as string;
    const flour = await item({ code: "FLR", name: "Flour", type: "ingredient", unit: "kg" });
    const cake = await item({ code: "CAKE", name: "Cake", type: "finished", unit: "each", unitWeightG: 450 });
    const recipe = (
      await ok(
        call("POST", "/recipes", {
          code: "R-CAKE",
          name: "Cake",
          outputItemId: cake,
          draft: {
            yieldQuantity: 12,
            yieldUnit: "each",
            lines: [{ itemId: flour, quantity: 3, unit: "kg" }],
          },
        }),
        201,
      )
    ).id;
    await ok(call("POST", `/recipes/${recipe}/draft/approve`));
    for (const plannedOn of [day(0), day(1)])
      await ok(
        call("POST", "/production/batches", { recipeId: recipe, plannedOn, batches: 1, lineId: line }),
        201,
      );
    await ok(call("POST", "/production/calendar", { from: day(1), lineId: line, reason: "Deep clean" }), 201);
    const result = await check(day(0), day(1));
    expect(slot(result, day(0)).production).toEqual({ planned: 1, nonWorkingDay: false });
    expect(req(result, day(0), firstAider.id)).toMatchObject({ applies: true, counted: [], shortfall: 1 });
    expect(req(result, day(1), firstAider.id)).toMatchObject({ applies: false, reason: "non_working_day" });
    // Nobody is rostered on day 1, so the operatives requirement is entirely unfilled.
    expect(req(result, day(1), operatives.id)).toMatchObject({ applies: true, counted: [], shortfall: 2 });
    expect(result.summary).toEqual({ requirementsChecked: 3, shortfalls: 3, unfilledPositions: 4 });
  });

  it("excludes people recorded as unavailable after they were rostered", async () => {
    await roster(ann, day(2));
    const leave = await ok(
      call("POST", "/workforce/hr/absences", {
        commandId: newId(),
        staffId: ann,
        kind: "annual_leave",
        startOn: day(2),
        endOn: day(2),
        staffNote: "",
        hrNote: "",
      }),
      201,
    );
    await ok(
      call("POST", `/workforce/hr/absences/${leave.id}/decision`, {
        commandId: newId(),
        expectedRevision: leave.revision,
        action: "approve",
        reason: "Booked",
      }),
    );
    const r = req(await check(day(2)), day(2), operatives.id);
    expect(r.counted).toEqual([]);
    expect(r.excluded).toEqual([{ staffId: ann, reasons: [{ reason: "unavailable" }] }]);
  });

  it("summarises training reasons for readers without Training access; tokens can read the check", async () => {
    await grant("people", "read");
    await grant("workforce", "read");
    const result = await check(day(0), day(0), member);
    const r = req(result, day(0), operatives.id);
    expect(r.courses).toBeNull();
    expect(r.shortfall).toBe(1);
    expect(r.excluded.find((e: any) => e.staffId === dee).reasons).toEqual([
      { reason: "competence_not_met" },
    ]);
    const viaToken = await ctx.req(`${WS}/workforce/staffing?from=${day(0)}&to=${day(0)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(viaToken.status).toBe(200);
    expect(
      (await call("POST", "/workforce/staffing/requirements", { commandId: newId() }, member)).status,
    ).toBe(403);
  });

  it("stops counting a requirement once it's deactivated", async () => {
    await ok(
      call("PATCH", `/workforce/staffing/requirements/${firstAider.id}`, {
        commandId: newId(),
        expectedRevision: firstAider.revision,
        shiftId: early.id,
        name: "First aider",
        headcount: 1,
        courseIds: [firstAid],
        appliesWhen: "production_planned",
        validFrom: monday,
        validTo: null,
        active: false,
      }),
    );
    expect(req(await check(day(0)), day(0), firstAider.id)).toBeUndefined();
  });

  // ─── Review fixes ───────────────────────────────────────────────────────────

  it("counts a leaver who is still within their notice period", async () => {
    const eve = await person("Eve", [operative]);
    await train(allergen, [eve], today);
    await ok(call("PATCH", `/people/staff/${eve}`, { status: "leaver", endDate: day(20) }));
    await roster(eve, day(5));
    const r = req(await check(day(5)), day(5), operatives.id);
    expect(r).toMatchObject({ counted: [eve], shortfall: 1 });
  });

  it("validates references on inactive requirements too, scoped to this workspace", async () => {
    const body = {
      commandId: newId(),
      expectedRevision: firstAider.revision + 1,
      shiftId: early.id,
      name: "First aider",
      headcount: 1,
      courseIds: [firstAid],
      appliesWhen: "production_planned",
      validFrom: monday,
      validTo: null,
      active: false,
    };
    const path = `/workforce/staffing/requirements/${firstAider.id}`;
    expect(await code(call("PATCH", path, { ...body, shiftId: newId() }), 404)).toBe("not_found");
    expect(await code(call("PATCH", path, { ...body, commandId: newId(), jobRoleId: newId() }), 404)).toBe(
      "not_found",
    );
    expect(await code(call("PATCH", path, { ...body, commandId: newId(), courseIds: [newId()] }), 404)).toBe(
      "not_found",
    );
  });

  it("ignores requirements on deactivated shifts and refuses new ones there", async () => {
    const night = await ok(
      call("POST", "/workforce/shifts", {
        commandId: newId(),
        name: "Night",
        startTime: "22:00",
        endTime: "06:00",
      }),
      201,
    );
    const needs = {
      shiftId: night.id,
      name: "Night operatives",
      headcount: 2,
      jobRoleId: operative,
      validFrom: monday,
    };
    await ok(call("POST", "/workforce/staffing/requirements", { commandId: newId(), ...needs }), 201);
    expect(slot(await check(day(6)), day(6), night.id).requirements[0].shortfall).toBe(2);
    await ok(
      call("PATCH", `/workforce/shifts/${night.id}`, {
        commandId: newId(),
        expectedRevision: night.revision,
        name: "Night",
        startTime: "22:00",
        endTime: "06:00",
        lineId: null,
        active: false,
      }),
    );
    expect(slot(await check(day(6)), day(6), night.id)).toBeUndefined();
    expect(
      await code(call("POST", "/workforce/staffing/requirements", { commandId: newId(), ...needs })),
    ).toBe("workforce_conflict");
  });

  it("keeps a since-archived course editable but refuses adding an archived one", async () => {
    const haccp = (
      await ok(
        call("POST", "/training/courses", { code: "HAC", title: "HACCP level 2", kind: "induction" }),
        201,
      )
    ).id;
    const fresh = (
      await ok(
        call("POST", "/training/courses", { code: "OLD", title: "Old induction", kind: "induction" }),
        201,
      )
    ).id;
    const fields = {
      shiftId: early.id,
      name: "HACCP lead",
      headcount: 1,
      courseIds: [haccp],
      validFrom: monday,
    };
    const created = await ok(
      call("POST", "/workforce/staffing/requirements", { commandId: newId(), ...fields }),
      201,
    );
    await ok(call("PATCH", `/training/courses/${haccp}`, { status: "archived" }));
    await ok(call("PATCH", `/training/courses/${fresh}`, { status: "archived" }));
    const update = {
      ...fields,
      weekdays: 127,
      appliesWhen: "always",
      jobRoleId: null,
      validTo: null,
      active: true,
    };
    const listed = (await ok(call("GET", "/workforce/staffing/requirements"))).requirements.find(
      (r: any) => r.id === created.id,
    );
    expect(listed.courses[0]).toMatchObject({ code: "HAC", active: false });
    const saved = await ok(
      call("PATCH", `/workforce/staffing/requirements/${created.id}`, {
        commandId: newId(),
        expectedRevision: created.revision,
        ...update,
        name: "HACCP lead (renamed)",
      }),
    );
    expect(
      await code(
        call("PATCH", `/workforce/staffing/requirements/${created.id}`, {
          commandId: newId(),
          expectedRevision: saved.revision,
          ...update,
          courseIds: [haccp, fresh],
        }),
        404,
      ),
    ).toBe("not_found");
    const r = req(await check(day(0)), day(0), created.id);
    expect(r.excluded[0].reasons[0].reason).toBe("course_archived");
  });

  it("shows production plans and course names only to readers of those modules", async () => {
    const result = await check(day(0), day(0), member);
    expect(slot(result, day(0)).production).toBeNull();
    const shifts = await ok(call("GET", "/workforce/shifts", undefined, member));
    expect(shifts.shifts.find((s: any) => s.id === early.id).lineName).toBeNull();
    expect(
      (await ok(call("GET", "/workforce/shifts"))).shifts.find((s: any) => s.id === early.id).lineName,
    ).toBe("Line 1");
    const list = await ok(call("GET", "/workforce/staffing/requirements", undefined, member));
    expect(list.requirements.every((r: any) => r.courses === null)).toBe(true);
    expect(slot(await check(day(0)), day(0)).production).toEqual({ planned: 1, nonWorkingDay: false });
  });
});
