import {
  addDays,
  DEFAULT_TIME_ZONE,
  isoWeekday,
  moduleIds,
  newId,
  todayInZone,
  WEEKDAYS_MON_FRI,
} from "@knotworking/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type Res, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";
const today = todayInZone(DEFAULT_TIME_ZONE);
/** The Monday at least a week ahead, so every date in these tests is in the future. */
const monday = addDays(today, 7 + ((7 - isoWeekday(today)) % 7));
const day = (n: number) => addDays(monday, n);

describe("3.4.4.2 rotas, working patterns and agency engagements", () => {
  let ctx: TestCtx, owner: string, member: string, memberId: string, token: string;
  let operative: string, early: any, night: any, ann: string, ben: string, cal: string, leaver: string;
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
  const person = async (firstName: string, extra: object = {}) =>
    (await ok(call("POST", "/people/staff", { firstName, lastName: "Rota", ...extra }), 201)).id as string;
  const shift = async (name: string, startTime: string, endTime: string) =>
    ok(call("POST", "/workforce/shifts", { commandId: newId(), name, startTime, endTime }), 201);
  const roster = (staffId: string, s: any, workDate: string, extra: object = {}, cookie = owner) =>
    call(
      "POST",
      "/workforce/rota/entries",
      { commandId: newId(), shiftId: s.id, staffId, workDate, jobRoleId: null, ...extra },
      cookie,
    );
  const rota = (from = monday, to = day(13)) => ok(call("GET", `/workforce/rota?from=${from}&to=${to}`));

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
          json: { name: "Planner", scope: "write" },
        }),
        201,
      )
    ).token;
    operative = (await ok(call("POST", "/people/job-roles", { name: "Line operative" }), 201)).id;
    ann = await person("Ann", { jobRoleIds: [operative] });
    ben = await person("Ben", { jobRoleIds: [operative], userId: memberId });
    cal = await person("Cal");
    leaver = await person("Lee", { startDate: addDays(today, -100), jobRoleIds: [operative] });
    await ok(call("PATCH", `/people/staff/${leaver}`, { endDate: day(2) }));
    early = await shift("Early", "06:00", "14:00");
    night = await shift("Night", "22:00", "06:00");
  }, 60_000);
  afterAll(() => ctx?.handle.close());

  it("defines shifts with unique names, including ones that cross midnight", async () => {
    expect(night).toMatchObject({ startTime: "22:00", endTime: "06:00", active: true, revision: 1 });
    expect(
      await code(
        call("POST", "/workforce/shifts", {
          commandId: newId(),
          name: "early",
          startTime: "07:00",
          endTime: "15:00",
        }),
      ),
    ).toBe("workforce_conflict");
    const list = await ok(call("GET", "/workforce/shifts"));
    expect(list.shifts.map((s: any) => s.name)).toEqual(["Early", "Night"]);
  });

  it("rosters people and refuses overlaps, roles not held, leavers and duplicates", async () => {
    const entry = await ok(roster(ann, early, day(0), { jobRoleId: operative }), 201);
    expect(entry).toMatchObject({ state: "active", jobRoleId: operative, revision: 1 });
    expect(await code(roster(ann, early, day(0)))).toBe("rota_already_rostered");
    // Sunday's night shift ends at 06:00 Monday, when Early starts: touching, not overlapping.
    await ok(roster(ann, night, day(-1)), 201);
    const late = await shift("Late overlap", "13:00", "21:00");
    expect(await code(roster(ann, late, day(0)))).toBe("rota_overlaps_another_shift");
    expect(await code(roster(cal, early, day(0), { jobRoleId: operative }))).toBe("rota_role_not_held");
    await ok(roster(leaver, early, day(2)), 201);
    expect(await code(roster(leaver, early, day(3)))).toBe("rota_not_employed");
  });

  it("won't roster someone recorded as unavailable, and shows later absences on the rota", async () => {
    const leave = await ok(
      call("POST", "/workforce/hr/absences", {
        commandId: newId(),
        staffId: ben,
        kind: "annual_leave",
        startOn: day(1),
        endOn: day(1),
        staffNote: "",
        hrNote: "",
      }),
      201,
    );
    await ok(roster(ben, early, day(2)), 201); // rostered before the next leave is approved
    await ok(
      call("POST", `/workforce/hr/absences/${leave.id}/decision`, {
        commandId: newId(),
        expectedRevision: leave.revision,
        action: "approve",
        reason: "Booked",
      }),
    );
    expect(await code(roster(ben, early, day(1)))).toBe("rota_unavailable");
    const second = await ok(
      call("POST", "/workforce/hr/absences", {
        commandId: newId(),
        staffId: ben,
        kind: "annual_leave",
        startOn: day(2),
        endOn: day(2),
        staffNote: "",
        hrNote: "",
      }),
      201,
    );
    await ok(
      call("POST", `/workforce/hr/absences/${second.id}/decision`, {
        commandId: newId(),
        expectedRevision: second.revision,
        action: "approve",
        reason: "Booked",
      }),
    );
    const view = await rota();
    expect(view.absenceSourceEnabled).toBe(true);
    const benEntry = view.entries.find((e: any) => e.staff.id === ben && e.workDate === day(2));
    expect(benEntry).toMatchObject({ unavailable: true, agency: null });
    expect(Object.keys(benEntry).sort()).not.toContain("kind");
  });

  it("cancels entries with a reason and stale-revision protection, and fixes shift times once used", async () => {
    const entry = await ok(roster(cal, early, day(4)), 201);
    const body = { commandId: newId(), expectedRevision: entry.revision, reason: "Swapped" };
    await ok(call("POST", `/workforce/rota/entries/${entry.id}/cancel`, body));
    expect(
      await code(call("POST", `/workforce/rota/entries/${entry.id}/cancel`, { ...body, commandId: newId() })),
    ).toBe("workforce_conflict");
    // Rerostering after a cancellation is allowed.
    await ok(roster(cal, early, day(4)), 201);
    const update = (extra: object) =>
      call("PATCH", `/workforce/shifts/${early.id}`, {
        commandId: newId(),
        expectedRevision: early.revision,
        name: "Early",
        startTime: "06:00",
        endTime: "14:00",
        lineId: null,
        active: true,
        ...extra,
      });
    expect(await code(update({ endTime: "14:30" }))).toBe("workforce_conflict");
    expect(await code(update({ active: false }))).toBe("workforce_conflict");
    early = await ok(update({ name: "Early shift" }));
    expect(early.revision).toBe(2);
  });

  it("generates entries from working patterns, reporting each skipped date", async () => {
    await ok(
      call("POST", "/workforce/patterns", {
        commandId: newId(),
        staffId: ben,
        shiftId: early.id,
        weekdays: WEEKDAYS_MON_FRI,
        jobRoleId: operative,
        validFrom: monday,
        validTo: day(11),
      }),
      201,
    );
    expect(
      await code(
        call("POST", "/workforce/patterns", {
          commandId: newId(),
          staffId: cal,
          shiftId: early.id,
          weekdays: 1,
          jobRoleId: operative,
          validFrom: monday,
        }),
      ),
    ).toBe("workforce_conflict");
    const command = { commandId: newId(), from: monday, to: day(13) };
    const first = await ok(call("POST", "/workforce/rota/generate", command));
    // Ten weekdays: Tuesday and Wednesday are on leave (Wednesday was also already rostered;
    // unavailability is reported first).
    expect(first.created).toBe(8);
    expect(first.skipped.map((s: any) => [s.workDate, s.reason])).toEqual([
      [day(1), "unavailable"],
      [day(2), "unavailable"],
    ]);
    expect(await ok(call("POST", "/workforce/rota/generate", command))).toEqual(first);
    const again = await ok(call("POST", "/workforce/rota/generate", { ...command, commandId: newId() }));
    expect(again.created).toBe(0);
    expect(again.skippedCount).toBe(10);
    const patterns = await ok(call("GET", `/workforce/patterns?staffId=${ben}`));
    const pattern = patterns.patterns[0];
    expect(
      await code(
        call("POST", `/workforce/patterns/${pattern.id}/end`, {
          commandId: newId(),
          expectedRevision: pattern.revision,
          validTo: day(20),
          reason: "Extend",
        }),
      ),
    ).toBe("workforce_conflict");
    await ok(
      call("POST", `/workforce/patterns/${pattern.id}/end`, {
        commandId: newId(),
        expectedRevision: pattern.revision,
        validTo: day(4),
        reason: "Moving to nights",
      }),
    );
  });

  it("records agency engagements for People records and shows the agency on the rota", async () => {
    const agency = await ok(
      call("POST", "/workforce/agencies", {
        commandId: newId(),
        name: "Staffline",
        contact: "bookings@example.test",
      }),
      201,
    );
    expect(await code(call("POST", "/workforce/agencies", { commandId: newId(), name: "staffline" }))).toBe(
      "workforce_conflict",
    );
    const engagement = await ok(
      call("POST", "/workforce/agency-engagements", {
        commandId: newId(),
        agencyId: agency.id,
        staffId: cal,
        startOn: monday,
        endOn: null,
        reference: "SL-204",
      }),
      201,
    );
    expect(
      await code(
        call("POST", "/workforce/agency-engagements", {
          commandId: newId(),
          agencyId: agency.id,
          staffId: cal,
          startOn: day(3),
          endOn: day(5),
        }),
      ),
    ).toBe("workforce_conflict");
    const view = await rota();
    expect(view.entries.find((e: any) => e.staff.id === cal && e.workDate === day(4)).agency).toEqual({
      id: agency.id,
      name: "Staffline",
      reference: "SL-204",
    });
    await ok(
      call("POST", `/workforce/agency-engagements/${engagement.id}/end`, {
        commandId: newId(),
        expectedRevision: engagement.revision,
        endOn: day(3),
        reason: "Assignment finished",
      }),
    );
    expect(
      (await rota()).entries.find((e: any) => e.staff.id === cal && e.workDate === day(4)).agency,
    ).toBeNull();
    const listed = await ok(call("GET", "/workforce/agencies"));
    expect(listed.engagements[0]).toMatchObject({ endOn: day(3), endReason: "Assignment finished" });
  });

  it("separates viewing, rostering and setup by module level; tokens may plan", async () => {
    await grant("people", "read");
    await grant("workforce", "read");
    const mine = await ok(call("GET", `/workforce/rota/me?from=${monday}&to=${day(13)}`, undefined, member));
    expect(mine.person.id).toBe(ben);
    expect(mine.entries.every((e: any) => e.staff.id === ben)).toBe(true);
    expect(mine.entries.length).toBeGreaterThan(0);
    await ok(call("GET", `/workforce/rota?from=${monday}&to=${day(6)}`, undefined, member));
    expect((await roster(cal, night, day(6), {}, member)).status).toBe(403);
    await grant("workforce", "write");
    await ok(roster(cal, night, day(6), {}, member), 201);
    expect(
      (
        await call(
          "POST",
          "/workforce/shifts",
          { commandId: newId(), name: "Mid", startTime: "10:00", endTime: "18:00" },
          member,
        )
      ).status,
    ).toBe(403);
    const viaToken = await ctx.req(`${WS}/workforce/rota/entries`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      json: { commandId: newId(), shiftId: night.id, staffId: ann, workDate: day(8), jobRoleId: null },
    });
    expect(viaToken.status).toBe(201);
    expect(await code(call("GET", `/workforce/rota?from=${monday}&to=${day(40)}`), 400)).toBe(
      "invalid_input",
    );
  });
});

describe("rotas without Private HR records", () => {
  it("can't see absences, so it says so rather than implying everyone is available", async () => {
    const ctx = await makeApp({ seed: true, activeModules: moduleIds.filter((m) => m !== "workforce_hr") });
    try {
      const owner = (await signIn(ctx, "ada@knotworking.dev")).cookie;
      const req = (method: string, path: string, json?: unknown) =>
        ctx.req(WS + path, { method, cookie: owner, json });
      const staffId = (
        await (await req("POST", "/people/staff", { firstName: "Solo", lastName: "Rota" })).json()
      ).id;
      const shift = await (
        await req("POST", "/workforce/shifts", {
          commandId: newId(),
          name: "Day",
          startTime: "08:00",
          endTime: "16:00",
        })
      ).json();
      expect(
        (
          await req("POST", "/workforce/rota/entries", {
            commandId: newId(),
            shiftId: shift.id,
            staffId,
            workDate: monday,
          })
        ).status,
      ).toBe(201);
      const view = await (await req("GET", `/workforce/rota?from=${monday}&to=${monday}`)).json();
      expect(view.absenceSourceEnabled).toBe(false);
      expect(view.entries[0].unavailable).toBeNull();
    } finally {
      await ctx.handle.close();
    }
  }, 60_000);
});
