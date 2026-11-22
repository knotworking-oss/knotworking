import { addDays, DEFAULT_TIME_ZONE, moduleIds, newId, todayInZone } from "@knotworking/core";
import {
  staff,
  syncChanges,
  users,
  workforceAbsences,
  workforceAbsenceEvents,
  workspaceMembers,
  workspaces,
} from "@knotworking/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { makeApp, signIn, type TestCtx, type Res } from "./test-utils";
const WS = "/v1/workspaces/acme";
const today = todayInZone(DEFAULT_TIME_ZONE);
describe("3.4.4.1 leave and private absence records", () => {
  let ctx: TestCtx,
    owner: string,
    employee: string,
    ownerId: string,
    employeeId: string,
    ws: string,
    ownStaffId: string,
    token: string;
  const call = (method: string, path: string, json?: unknown, cookie = owner) =>
    ctx.req(WS + path, { method, cookie, json });
  const ok = async (input: Promise<Res> | Res, status = 200) => {
    const r = await input;
    const b = await r.json();
    expect(r.status, JSON.stringify(b)).toBe(status);
    return b;
  };
  const grant = (module: string, level: string) =>
    ok(call("PUT", `/members/${employeeId}/module-access/${module}`, { level }));
  const person = (extra: object = {}) =>
    ok(call("POST", "/people/staff", { firstName: "Workforce", lastName: newId(), ...extra }), 201);
  const create = (staffId: string, extra: object = {}) =>
    ok(
      call("POST", "/workforce/hr/absences", {
        commandId: newId(),
        staffId,
        kind: "annual_leave",
        startOn: addDays(today, 10),
        endOn: addDays(today, 11),
        staffNote: "",
        hrNote: "",
        ...extra,
      }),
      201,
    );
  const decide = (row: any, action = "approve", extra: object = {}) =>
    call("POST", `/workforce/hr/absences/${row.id}/decision`, {
      commandId: newId(),
      expectedRevision: row.revision,
      action,
      reason: "Reviewed absence",
      ...extra,
    });
  const history = (id: string) => ok(call("GET", `/workforce/hr/absences/${id}/history`));
  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    owner = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    employee = (await signIn(ctx, "marcus@knotworking.dev")).cookie;
    ownerId = (await ok(ctx.req("/v1/me", { cookie: owner }))).user.id;
    employeeId = (await ok(ctx.req("/v1/me", { cookie: employee }))).user.id;
    ws = (await ok(call("GET", "/bootstrap"))).workspace.id;
    await grant("people", "read");
    await grant("workforce", "read");
    ownStaffId = (await person({ firstName: "Marcus", lastName: "Worker", userId: employeeId })).id;
    token = (
      await ok(
        ctx.req("/v1/me/api-tokens", {
          cookie: owner,
          method: "POST",
          json: { name: "Planning only", scope: "write" },
        }),
        201,
      )
    ).token;
  }, 60000);
  afterAll(async () => {
    await ctx?.handle.close();
  });
  it("lets read-only workforce members request their own leave and replay without duplicates", async () => {
    const input = {
      commandId: newId(),
      kind: "annual_leave",
      startOn: addDays(today, 20),
      endOn: addDays(today, 21),
      staffNote: "Own submission",
    };
    const row = await ok(call("POST", "/workforce/me/absences", input, employee), 201);
    expect((await ok(call("POST", "/workforce/me/absences", input, employee), 201)).id).toBe(row.id);
    expect((await history(row.id)).events).toHaveLength(1);
    await ok(
      call(
        "POST",
        "/workforce/me/absences",
        { ...input, commandId: newId(), hrNote: "Privilege injection" },
        employee,
      ),
      400,
    );
    const approved = await ok(decide(row, "approve", { hrNote: "HR-ONLY-SECRET" }));
    expect(approved.state).toBe("approved");
    const mine = await ok(call("GET", "/workforce/me", undefined, employee));
    expect(mine.absences.some((a: any) => a.id === row.id)).toBe(true);
    expect(JSON.stringify(mine)).not.toContain("HR-ONLY-SECRET");
    expect(mine.absences.every((a: any) => !("hrNote" in a))).toBe(true);
    await ok(
      call(
        "POST",
        `/workforce/me/absences/${row.id}/withdraw`,
        { commandId: newId(), expectedRevision: approved.revision, reason: "Try approved withdrawal" },
        employee,
      ),
      409,
    );
    await ok(decide(row), 409);
  });
  it("withdraws pending requests and refuses stale or mismatched commands", async () => {
    const row = await ok(
      call(
        "POST",
        "/workforce/me/absences",
        { commandId: newId(), kind: "other_leave", startOn: addDays(today, 30), endOn: addDays(today, 30) },
        employee,
      ),
      201,
    );
    const input = { commandId: newId(), expectedRevision: row.revision, reason: "Plans changed" };
    expect((await ok(call("POST", `/workforce/me/absences/${row.id}/withdraw`, input, employee))).state).toBe(
      "cancelled",
    );
    expect((await ok(call("POST", `/workforce/me/absences/${row.id}/withdraw`, input, employee))).state).toBe(
      "cancelled",
    );
    await ok(
      call(
        "POST",
        `/workforce/me/absences/${row.id}/withdraw`,
        { ...input, reason: "Different command" },
        employee,
      ),
      409,
    );
  });
  it("separates ordinary People/planning permissions from private HR access", async () => {
    await grant("people", "manage");
    await grant("workforce", "manage");
    await ok(call("GET", "/workforce/hr/absences", undefined, employee), 403);
    for (const path of ["/workforce/me", "/workforce/hr/absences", "/workforce/hr/staff"]) {
      await ok(ctx.req(WS + path, { headers: { authorization: `Bearer ${token}` } }), 403);
    }
    await grant("workforce", "read");
  });
  it("prevents self approval and records sickness as acknowledgement, not leave approval", async () => {
    const ownerStaff = await person({ userId: ownerId });
    const own = await ok(
      call("POST", "/workforce/me/absences", {
        commandId: newId(),
        kind: "annual_leave",
        startOn: today,
        endOn: today,
      }),
      201,
    );
    await ok(decide(own), 409);
    await ok(decide(own, "cancel"), 409);
    const p = await person();
    const sick = await create(p.id, {
      kind: "sickness",
      startOn: today,
      endOn: null,
      staffNote: "PRIVATE-HEALTH-DETAIL",
      hrNote: "RESTRICTED-HR-NOTE",
    });
    expect(sick.state).toBe("reported");
    await ok(decide(sick, "approve"), 409);
    const recorded = await ok(decide(sick, "record"));
    expect(recorded.state).toBe("recorded");
    const corrected = await ok(
      call("POST", `/workforce/hr/absences/${recorded.id}/correct`, {
        commandId: newId(),
        expectedRevision: recorded.revision,
        startOn: today,
        endOn: today,
        reason: "Returned to work; record last absence day",
        hrNote: "Revised restricted note",
      }),
    );
    expect(corrected.endOn).toBe(today);
    const h = await history(sick.id);
    expect(h.events.map((e: any) => e.action)).toEqual(["submitted", "record", "corrected"]);
    expect(h.events[0].snapshot.endOn).toBeNull();
    expect(h.events[0].snapshot.hrNote).toBe("RESTRICTED-HR-NOTE");
    // Owner link is a real People record, not a duplicate user directory.
    expect(ownerStaff.id).toBeDefined();
  });
  it("returns dates only to planners/tokens and excludes pending/rejected/cancelled leave", async () => {
    const p = await person();
    const pending = await create(p.id);
    const active = await ok(decide(pending));
    const url = `${WS}/workforce/availability?from=${today}&to=${addDays(today, 40)}`;
    const r = await ok(ctx.req(url, { headers: { authorization: `Bearer ${token}` } }));
    expect(r.availability.some((a: any) => a.staffId === p.id)).toBe(true);
    for (const row of r.availability)
      expect(Object.keys(row).sort()).toEqual([
        "availability",
        "firstName",
        "from",
        "lastName",
        "staffId",
        "staffNumber",
        "to",
      ]);
    expect(JSON.stringify(r)).not.toMatch(
      /PRIVATE-HEALTH-DETAIL|RESTRICTED-HR-NOTE|HR-ONLY-SECRET|sickness|staffNote|hrNote|requestedBy/,
    );
    await ok(decide(active, "cancel"));
    const after = await ok(ctx.req(url, { cookie: employee }));
    expect(after.availability.some((a: any) => a.staffId === p.id)).toBe(false);
    const second = await create(p.id);
    await ok(decide(second, "reject"));
    expect(
      (await ok(ctx.req(url, { cookie: employee }))).availability.some((a: any) => a.staffId === p.id),
    ).toBe(false);
  });
  it("accepts sickness over booked leave, flags private review and merges availability without double counting", async () => {
    const p = await person();
    const leave = await create(p.id, { startOn: today, endOn: addDays(today, 7) });
    await ok(decide(leave));
    await create(p.id, { kind: "sickness", startOn: today, endOn: null, hrNote: "OVERLAP-PRIVATE" });
    const hr = await ok(call("GET", `/workforce/hr/absences?staffId=${p.id}`));
    expect(hr.absences.every((row: any) => row.overlapNeedsReview)).toBe(true);
    const publicResult = await ok(
      call("GET", `/workforce/availability?from=${today}&to=${addDays(today, 10)}`, undefined, employee),
    );
    const ranges = publicResult.availability.filter((row: any) => row.staffId === p.id);
    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toMatchObject({ from: today, to: addDays(today, 10) });
    expect(JSON.stringify(publicResult)).not.toContain("OVERLAP-PRIVATE");
    await ok(
      call("POST", "/workforce/hr/absences", {
        commandId: newId(),
        staffId: p.id,
        kind: "sickness",
        startOn: today,
        endOn: null,
      }),
      409,
    );
  });
  it("serialises overlapping requests and concurrent review/withdrawal", async () => {
    const p = await person();
    const input = { staffId: p.id, kind: "annual_leave", startOn: today, endOn: today };
    const responses = await Promise.all([
      call("POST", "/workforce/hr/absences", { ...input, commandId: newId() }),
      call("POST", "/workforce/hr/absences", { ...input, commandId: newId() }),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    const row = await ok(
      call(
        "POST",
        "/workforce/me/absences",
        { commandId: newId(), kind: "annual_leave", startOn: addDays(today, 40), endOn: addDays(today, 40) },
        employee,
      ),
      201,
    );
    const reviews = await Promise.all([
      decide(row),
      call(
        "POST",
        `/workforce/me/absences/${row.id}/withdraw`,
        { commandId: newId(), expectedRevision: row.revision, reason: "Withdraw concurrently" },
        employee,
      ),
    ]);
    expect(reviews.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await history(row.id)).events).toHaveLength(2);
  });
  it("does not expose historical HR data after a People manager relinks a login", async () => {
    const p = await person();
    const record = await create(p.id, {
      kind: "sickness",
      startOn: today,
      endOn: today,
      staffNote: "VICTIM-HEALTH-PRIVATE",
      hrNote: "VICTIM-HR-PRIVATE",
    });
    await ok(call("PATCH", `/people/staff/${ownStaffId}`, { userId: null }));
    await ok(call("PATCH", `/people/staff/${p.id}`, { userId: employeeId }, employee));
    const mine = await ok(call("GET", "/workforce/me", undefined, employee));
    expect(mine.person.id).toBe(p.id);
    expect(mine.absences).toEqual([]);
    expect(JSON.stringify(mine)).not.toContain("VICTIM");
    await ok(call("GET", `/workforce/hr/absences/${record.id}/history`, undefined, employee), 403);
    await ok(
      call(
        "POST",
        `/workforce/me/absences/${record.id}/withdraw`,
        { commandId: newId(), expectedRevision: 1, reason: "Probe someone else's record" },
        employee,
      ),
      404,
    );
    await ok(call("PATCH", `/people/staff/${p.id}`, { userId: null }));
    await ok(call("PATCH", `/people/staff/${ownStaffId}`, { userId: employeeId }));
  });
  it("checks employment dates, workspace dates and retained-record deletion", async () => {
    const p = await person({ startDate: addDays(today, -10) });
    await ok(
      call("POST", "/workforce/hr/absences", {
        commandId: newId(),
        staffId: p.id,
        kind: "annual_leave",
        startOn: addDays(today, -11),
        endOn: today,
      }),
      409,
    );
    await create(p.id);
    await ok(call("PATCH", `/people/staff/${p.id}`, { staffNumber: "999998" }), 409);
    await ok(call("DELETE", `/people/staff/${p.id}`), 409);
    const zoneStaff = await person();
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-15T23:30:00Z"));
    try {
      await ctx.handle.db
        .update(workspaces)
        .set({ timeZone: "Pacific/Kiritimati" })
        .where(eq(workspaces.id, ws));
      await create(zoneStaff.id, { kind: "sickness", startOn: "2026-11-16", endOn: "2026-11-16" });
      await ok(
        call("POST", "/workforce/hr/absences", {
          commandId: newId(),
          staffId: zoneStaff.id,
          kind: "sickness",
          startOn: "2026-11-17",
          endOn: null,
        }),
        409,
      );
    } finally {
      clock.mockRestore();
      await ctx.handle.db
        .update(workspaces)
        .set({ timeZone: DEFAULT_TIME_ZONE })
        .where(eq(workspaces.id, ws));
    }
  });
  it("supports explicitly granted HR readers/managers while keeping write decisions privileged", async () => {
    const p = await person();
    const row = await create(p.id);
    await grant("workforce_hr", "read");
    const read = await ok(call("GET", "/workforce/hr/absences", undefined, employee));
    expect(read.absences.some((r: any) => r.hrNote === "HR-ONLY-SECRET")).toBe(true);
    const fresh = row;
    const input = {
      commandId: newId(),
      expectedRevision: fresh.revision,
      action: "approve",
      reason: "Read role must not approve",
    };
    await ok(call("POST", `/workforce/hr/absences/${fresh.id}/decision`, input, employee), 403);
    await grant("workforce_hr", "write");
    await ok(call("POST", `/workforce/hr/absences/${fresh.id}/decision`, input, employee), 403);
    await grant("workforce_hr", "manage");
    expect(
      (await ok(call("POST", `/workforce/hr/absences/${fresh.id}/decision`, input, employee))).state,
    ).toBe("approved");
    await grant("workforce_hr", "none");
    await ok(call("GET", "/workforce/hr/absences", undefined, employee), 403);
  });
  it("scopes HR rows and history to their workspace and keeps every note outside shared sync", async () => {
    const other = newId();
    await ctx.handle.db.insert(workspaces).values({ id: other, name: "Other", slug: "other-workforce" });
    await ctx.handle.db
      .insert(workspaceMembers)
      .values({ workspaceId: other, userId: ownerId, role: "owner" });
    const p = await person();
    const row = await create(p.id);
    expect(
      (
        await ctx.req(`/v1/workspaces/other-workforce/workforce/hr/absences/${row.id}/history`, {
          cookie: owner,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await ctx.req(`/v1/workspaces/other-workforce/workforce/hr/absences`, {
          method: "POST",
          cookie: owner,
          json: { commandId: newId(), staffId: p.id, kind: "annual_leave", startOn: today, endOn: today },
        })
      ).status,
    ).toBe(404);
    const privateIds = new Set(
      (
        await ctx.handle.db
          .select({ id: workforceAbsences.id })
          .from(workforceAbsences)
          .where(eq(workforceAbsences.workspaceId, ws))
      ).map((r) => r.id),
    );
    const changes = await ctx.handle.db.select().from(syncChanges).where(eq(syncChanges.workspaceId, ws));
    expect(changes.some((r) => privateIds.has(r.entityId))).toBe(false);
    expect(JSON.stringify(changes.map((change) => change.data))).not.toMatch(
      /VICTIM-HR-PRIVATE|PRIVATE-HEALTH-DETAIL|HR-ONLY-SECRET/,
    );
    expect((await ctx.handle.db.select().from(workforceAbsenceEvents)).length).toBeGreaterThan(0);
  });
});
describe("workforce module boundaries", () => {
  let ctx: TestCtx;
  afterAll(async () => {
    await ctx?.handle.close();
  });
  it("hides private-derived data and requests when the HR module is inactive", async () => {
    ctx = await makeApp({ seed: true, activeModules: ["people", "workforce"] });
    const cookie = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    const my = await (await ctx.req(WS + "/workforce/me", { cookie })).json();
    expect(my.enabled).toBe(false);
    expect(my.absences).toEqual([]);
    const available = await (
      await ctx.req(WS + `/workforce/availability?from=${today}&to=${today}`, { cookie })
    ).json();
    expect(available.sourceEnabled).toBe(false);
    expect(available.availability).toEqual([]);
    expect((await ctx.req(WS + "/workforce/hr/absences", { cookie })).status).toBe(404);
    expect(
      (
        await ctx.req(WS + "/workforce/me/absences", {
          method: "POST",
          cookie,
          json: { commandId: newId(), kind: "annual_leave", startOn: today, endOn: today },
        })
      ).status,
    ).toBe(404);
  }, 30000);
});
