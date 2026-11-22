import { createHash } from "node:crypto";
import { newId } from "@knotworking/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type Res, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";
const MARCH = { from: "2026-03-01", to: "2026-03-31" };

describe("3.4.4.4 payroll runs and provider-neutral exports", () => {
  let ctx: TestCtx, ada: string, marcus: string, marcusId: string, token: string;
  let pat: string, sam: string, agencyWorker: string, pendingLeave: any;
  let run: any;
  const call = (method: string, path: string, json?: unknown, cookie = ada) =>
    ctx.req(WS + path, { method, cookie, json });
  const ok = async (input: Promise<Res> | Res, status = 200) => {
    const r = await input;
    const b = await r.json();
    expect(r.status, JSON.stringify(b)).toBe(status);
    return b;
  };
  const code = async (input: Promise<Res> | Res, status = 409) => (await ok(input, status)).error.code;
  const grant = (module: string, level: string | null) =>
    ok(call("PUT", `/members/${marcusId}/module-access/${module}`, { level }));
  const person = async (firstName: string, extra: object = {}) =>
    (await ok(call("POST", "/people/staff", { firstName, lastName: "Payroll", ...extra }), 201)).id as string;
  const clock = (staffId: string, kind: "in" | "out", at: string) =>
    ok(call("POST", "/attendance/events", { staffId, kind, at, reason: "Timesheet" }), 201);
  const shift = async (staffId: string, date: string) => {
    await clock(staffId, "in", `${date}T08:00:00Z`);
    await clock(staffId, "out", `${date}T16:00:00Z`);
  };
  const absence = async (
    staffId: string,
    kind: string,
    startOn: string,
    endOn: string | null,
    decide?: string,
  ) => {
    const row = await ok(
      call("POST", "/workforce/hr/absences", {
        commandId: newId(),
        staffId,
        kind,
        startOn,
        endOn,
        staffNote: "",
        hrNote: "",
      }),
      201,
    );
    if (decide)
      await ok(
        call("POST", `/workforce/hr/absences/${row.id}/decision`, {
          commandId: newId(),
          expectedRevision: row.revision,
          action: decide,
          reason: "Reviewed",
        }),
      );
    return row;
  };
  const exportRun = (id: string, adapterId: string, extra: object = {}, cookie = ada) =>
    call(
      "POST",
      `/workforce/hr/payroll-runs/${id}/export`,
      { commandId: newId(), adapterId, ...extra },
      cookie,
    );

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    marcus = (await signIn(ctx, "marcus@knotworking.dev")).cookie;
    marcusId = (await ok(ctx.req("/v1/me", { cookie: marcus }))).user.id;
    token = (
      await ok(
        ctx.req("/v1/me/api-tokens", {
          cookie: ada,
          method: "POST",
          json: { name: "Agent", scope: "write" },
        }),
        201,
      )
    ).token;
    pat = await person("Pat", { payrollReference: "P-17" });
    sam = await person("Sam");
    agencyWorker = await person("Alex");
    for (const d of ["2026-03-02", "2026-03-03", "2026-03-04"]) await shift(pat, d);
    await shift(sam, "2026-03-05");
    await shift(agencyWorker, "2026-03-06");
    await clock(pat, "in", "2026-03-30T08:00:00Z"); // no clock-out yet: a shift to fix
    await absence(sam, "annual_leave", "2026-03-09", "2026-03-13", "approve");
    await absence(sam, "sickness", "2026-03-20", "2026-03-21");
    pendingLeave = await absence(sam, "annual_leave", "2026-03-25", "2026-03-25");
    const agency = await ok(
      call("POST", "/workforce/agencies", { commandId: newId(), name: "Staffline" }),
      201,
    );
    await ok(
      call("POST", "/workforce/agency-engagements", {
        commandId: newId(),
        agencyId: agency.id,
        staffId: agencyWorker,
        startOn: "2026-01-01",
        reference: "SL-9",
      }),
      201,
    );
    for (const m of ["people", "workforce", "attendance"]) await grant(m, m === "people" ? "read" : "manage");
    await grant("workforce_hr", "manage");
  }, 120_000);
  afterAll(() => ctx?.handle.close());

  it("won't prepare a run while shifts are open or leave is undecided", async () => {
    const preview = await ok(
      call("GET", `/workforce/hr/payroll-runs/preview?from=${MARCH.from}&to=${MARCH.to}`),
    );
    expect(preview.blockers).toHaveLength(2);
    expect(preview.blockers.join(" ")).toMatch(/missing or overlong clock event/);
    expect(preview.blockers.join(" ")).toMatch(/awaiting a decision/);
    expect(await code(call("POST", "/workforce/hr/payroll-runs", { commandId: newId(), ...MARCH }))).toBe(
      "payroll_run_blocked",
    );
    await clock(pat, "out", "2026-03-30T12:00:00Z");
    await ok(
      call("POST", `/workforce/hr/absences/${pendingLeave.id}/decision`, {
        commandId: newId(),
        expectedRevision: pendingLeave.revision,
        action: "reject",
        reason: "Cover not available",
      }),
    );
    expect(
      (await ok(call("GET", `/workforce/hr/payroll-runs/preview?from=${MARCH.from}&to=${MARCH.to}`)))
        .blockers,
    ).toEqual([]);
  });

  it("freezes hours and absence days per employee, listing agency workers separately", async () => {
    run = await ok(
      call("POST", "/workforce/hr/payroll-runs", { commandId: newId(), ...MARCH, note: "March" }),
      201,
    );
    expect(run).toMatchObject({ state: "prepared", version: 1, employees: 2, agencyWorkers: 1 });
    const detail = await ok(call("GET", `/workforce/hr/payroll-runs/${run.id}`));
    const hours = await ok(call("GET", `/attendance/payroll?from=${MARCH.from}&to=${MARCH.to}`));
    const byId = Object.fromEntries(detail.snapshot.employees.map((e: any) => [e.staffId, e]));
    const live = Object.fromEntries(hours.rows.map((r: any) => [r.staffId, r]));
    expect(byId[pat]).toMatchObject({
      payrollReference: "P-17",
      shifts: 4,
      basicMinutes: live[pat].basicMinutes,
      absenceDays: { annual_leave: 0, other_leave: 0, sickness: 0 },
    });
    // The rejected request doesn't count; reported sickness does, with a warning to acknowledge it.
    expect(byId[sam].absenceDays).toEqual({ annual_leave: 5, other_leave: 0, sickness: 2 });
    expect(byId[agencyWorker]).toBeUndefined();
    expect(detail.snapshot.agencyWorkers).toEqual([
      expect.objectContaining({
        staffId: agencyWorker,
        agencyName: "Staffline",
        reference: "SL-9",
        shifts: 1,
      }),
    ]);
    expect(detail.snapshot.warnings.join(" ")).toMatch(/sickness report hasn't been acknowledged/);
    expect(detail.history.map((h: any) => h.action)).toEqual(["prepared"]);
    expect(
      await code(
        call("POST", "/workforce/hr/payroll-runs", {
          commandId: newId(),
          from: "2026-03-15",
          to: "2026-04-14",
        }),
      ),
    ).toBe("payroll_run_overlap");
  });

  it("needs a second person to approve before anything can be exported", async () => {
    expect(await code(exportRun(run.id, "teamflow_hr_csv"))).toBe("payroll_run_not_approved");
    const approve = (cookie: string, extra: object = {}) =>
      call(
        "POST",
        `/workforce/hr/payroll-runs/${run.id}/approve`,
        { commandId: newId(), expectedRevision: run.revision, note: "Checked against timesheets", ...extra },
        cookie,
      );
    expect(await code(approve(ada))).toBe("payroll_run_four_eyes");
    run = await ok(approve(marcus));
    expect(run).toMatchObject({ state: "approved", approvedBy: marcusId });
  });

  it("exports the approved snapshot, records each export once, and gates unverified package layouts", async () => {
    const commandId = newId();
    const body = { commandId, adapterId: "teamflow_hr_csv" };
    const file = await ok(call("POST", `/workforce/hr/payroll-runs/${run.id}/export`, body));
    expect(file.fileName).toBe("payroll-run-2026-03-01-to-2026-03-31.csv");
    expect(file.fileHash).toBe(createHash("sha256").update(file.csv).digest("hex"));
    const lines = file.csv.replace(/^﻿/, "").split("\r\n");
    expect(lines[0]).toContain("Annual leave days,Other leave days,Sickness days");
    const samNumber = (await ok(call("GET", `/people/staff/${sam}`))).staffNumber;
    expect(lines.find((l: string) => l.startsWith(`${samNumber},`))).toMatch(/,5,0,2$/);
    expect(file.csv).not.toContain("Alex");
    await ok(call("POST", `/workforce/hr/payroll-runs/${run.id}/export`, body));
    const history = (await ok(call("GET", `/workforce/hr/payroll-runs/${run.id}`))).history;
    expect(history.filter((h: any) => h.action === "exported")).toHaveLength(1);
    expect(history.at(-1).detail).toMatchObject({
      adapterId: "teamflow_hr_csv",
      fileHash: file.fileHash,
      acknowledgedUnverified: false,
    });

    expect(await code(exportRun(run.id, "sage50_payroll_hours"))).toBe("payroll_adapter_unverified");
    expect(await code(exportRun(run.id, "sage50_payroll_hours", { acknowledgeUnverified: true }))).toBe(
      "payroll_export_blocked",
    );
    expect(await code(exportRun(run.id, "nope"), 400)).toBe("invalid_input");
  });

  it("corrects a run as a new version that supersedes the original once approved", async () => {
    // References are copied when a run is prepared, so a settings change needs a correction.
    await ok(
      call("PATCH", "/attendance/settings", { sageBasicPaymentRef: "1", sageOvertimePaymentRef: "4" }),
    );
    await ok(call("PATCH", `/people/staff/${sam}`, { payrollReference: "S-2" }));
    expect(await code(exportRun(run.id, "sage50_payroll_hours", { acknowledgeUnverified: true }))).toBe(
      "payroll_export_blocked",
    );
    const correction = await ok(
      call(
        "POST",
        `/workforce/hr/payroll-runs/${run.id}/correct`,
        { commandId: newId(), expectedRevision: run.revision, reason: "Sage references added" },
        marcus,
      ),
      201,
    );
    expect(correction).toMatchObject({ state: "prepared", version: 2, supersedesId: run.id });
    expect((await ok(call("GET", `/workforce/hr/payroll-runs/${run.id}`))).run.state).toBe("approved");
    const approved = await ok(
      call("POST", `/workforce/hr/payroll-runs/${correction.id}/approve`, {
        commandId: newId(),
        expectedRevision: correction.revision,
        note: "Reviewed correction",
      }),
    );
    expect(approved.state).toBe("approved");
    expect((await ok(call("GET", `/workforce/hr/payroll-runs/${run.id}`))).run.state).toBe("superseded");
    expect(await code(exportRun(run.id, "teamflow_hr_csv"))).toBe("payroll_run_not_approved");
    const sage = await ok(exportRun(correction.id, "sage50_payroll_hours", { acknowledgeUnverified: true }));
    expect(sage.csv.replace(/^﻿/, "").split("\r\n")[0]).toBe("Employee Reference,Payment Reference,Hours");
    expect(sage.csv).toContain("P-17,1,");
    expect(sage.manualAbsences).toEqual([
      expect.objectContaining({
        firstName: "Sam",
        absenceDays: { annual_leave: 5, other_leave: 0, sickness: 2 },
      }),
    ]);
    const exported = (await ok(call("GET", `/workforce/hr/payroll-runs/${correction.id}`))).history.at(-1);
    expect(exported.detail.acknowledgedUnverified).toBe(true);
    const list = await ok(call("GET", "/workforce/hr/payroll-runs"));
    expect(list.runs.map((r: any) => [r.version, r.state])).toEqual([
      [2, "approved"],
      [1, "superseded"],
    ]);
    expect(list.adapters.find((a: any) => a.id === "sage50_payroll_hours").compatibility.status).toBe(
      "unverified",
    );
  });

  it("refuses an approver whose own hours are in the run", async () => {
    const own = await person("Marc", { userId: marcusId });
    await shift(own, "2026-04-02");
    const april = await ok(
      call("POST", "/workforce/hr/payroll-runs", {
        commandId: newId(),
        from: "2026-04-01",
        to: "2026-04-30",
      }),
      201,
    );
    expect(
      await code(
        call(
          "POST",
          `/workforce/hr/payroll-runs/${april.id}/approve`,
          { commandId: newId(), expectedRevision: april.revision, note: "Mine" },
          marcus,
        ),
      ),
    ).toBe("payroll_run_own_record");
    // Unlinking the People record before approving doesn't get round it.
    await ok(call("PATCH", `/people/staff/${own}`, { userId: null }));
    expect(
      await code(
        call(
          "POST",
          `/workforce/hr/payroll-runs/${april.id}/approve`,
          { commandId: newId(), expectedRevision: april.revision, note: "Mine" },
          marcus,
        ),
      ),
    ).toBe("payroll_run_own_record");
  });

  it("refuses an export command replayed for a different file or person", async () => {
    const runs = (await ok(call("GET", "/workforce/hr/payroll-runs"))).runs;
    const current = runs.find((r: any) => r.state === "approved");
    const body = { commandId: newId(), adapterId: "teamflow_hr_csv" };
    await ok(call("POST", `/workforce/hr/payroll-runs/${current.id}/export`, body));
    const replay = (extra: object, cookie = ada) =>
      call("POST", `/workforce/hr/payroll-runs/${current.id}/export`, { ...body, ...extra }, cookie);
    expect(await code(replay({ adapterId: "sage50_payroll_hours", acknowledgeUnverified: true }))).toBe(
      "command_conflict",
    );
    expect(await code(replay({}, marcus))).toBe("command_conflict");
    await ok(replay({}));
  });

  it("withdraws a prepared run so it no longer blocks its period", async () => {
    const wrong = await ok(
      call("POST", "/workforce/hr/payroll-runs", {
        commandId: newId(),
        from: "2026-07-01",
        to: "2026-08-01",
      }),
      201,
    );
    const august = { commandId: newId(), from: "2026-08-01", to: "2026-08-31" };
    expect(await code(call("POST", "/workforce/hr/payroll-runs", august))).toBe("payroll_run_overlap");
    const withdrawn = await ok(
      call("POST", `/workforce/hr/payroll-runs/${wrong.id}/withdraw`, {
        commandId: newId(),
        expectedRevision: wrong.revision,
        reason: "Wrong dates",
      }),
    );
    expect(withdrawn.state).toBe("withdrawn");
    await ok(call("POST", "/workforce/hr/payroll-runs", { ...august, commandId: newId() }), 201);
    expect(await code(exportRun(wrong.id, "teamflow_hr_csv"))).toBe("payroll_run_not_approved");
    const history = (await ok(call("GET", `/workforce/hr/payroll-runs/${wrong.id}`))).history;
    expect(history.at(-1)).toMatchObject({ action: "withdrawn", detail: { reason: "Wrong dates" } });
  });

  it("clips absence days to employment and today, and splits part-period agency workers", async () => {
    // Part-period agency: engaged 1–10 May, then employed directly.
    const jo = await person("Jo", { payrollReference: "J-1" });
    const agency = (await ok(call("GET", "/workforce/agencies"))).agencies[0];
    await ok(
      call("POST", "/workforce/agency-engagements", {
        commandId: newId(),
        agencyId: agency.id,
        staffId: jo,
        startOn: "2026-05-01",
        endOn: "2026-05-10",
      }),
      201,
    );
    await shift(jo, "2026-05-05");
    await shift(jo, "2026-05-20");
    await absence(jo, "annual_leave", "2026-05-08", "2026-05-08", "approve");
    await absence(jo, "annual_leave", "2026-05-25", "2026-05-25", "approve");
    // A leaver with open sickness and leave booked after their leaving date.
    const lee = await person("Lee");
    await absence(lee, "annual_leave", "2026-05-20", "2026-05-22", "approve");
    const sick = await absence(lee, "sickness", "2026-05-12", null);
    await ok(call("PATCH", `/people/staff/${lee}`, { status: "leaver", endDate: "2026-05-15" }));
    const may = "from=2026-05-01&to=2026-05-31";
    const blocked = await ok(call("GET", `/workforce/hr/payroll-runs/preview?${may}`));
    expect(blocked.blockers.join(" ")).toMatch(/sickness with no last day/);
    await ok(
      call("POST", `/workforce/hr/absences/${sick.id}/correct`, {
        commandId: newId(),
        expectedRevision: sick.revision,
        startOn: "2026-05-12",
        endOn: "2026-05-14",
        reason: "Last day recorded",
      }),
    );
    const preview = await ok(call("GET", `/workforce/hr/payroll-runs/preview?${may}`));
    expect(preview.blockers).toEqual([]);
    const employees = Object.fromEntries(preview.snapshot.employees.map((e: any) => [e.staffId, e]));
    expect(employees[jo]).toMatchObject({
      shifts: 1,
      absenceDays: { annual_leave: 1, other_leave: 0, sickness: 0 },
    });
    const agencyRow = preview.snapshot.agencyWorkers.find((a: any) => a.staffId === jo);
    expect(agencyRow).toMatchObject({ shifts: 1 });
    expect(employees[jo].basicMinutes).toBe(agencyRow.basicMinutes);
    expect(employees[lee].absenceDays).toEqual({ annual_leave: 0, other_leave: 0, sickness: 3 });
    expect(preview.snapshot.warnings.join(" ")).toMatch(/agency-supplied for part of the period/);
  });

  it("counts open sickness only up to today in an unfinished period", async () => {
    const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
    const ola = await person("Ola");
    await absence(ola, "sickness", day(-2), null);
    const preview = await ok(call("GET", `/workforce/hr/payroll-runs/preview?from=${day(-5)}&to=${day(5)}`));
    const row = preview.snapshot.employees.find((e: any) => e.staffId === ola);
    expect(row.absenceDays.sickness).toBe(3);
    expect(preview.snapshot.warnings.join(" ")).toMatch(/open sickness counts only up to today/);
  });

  it("is for signed-in people with Private HR and Attendance manage only", async () => {
    const viaToken = await ctx.req(`${WS}/workforce/hr/payroll-runs`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(viaToken.status).toBe(403);
    await grant("attendance", "write");
    expect((await call("GET", "/workforce/hr/payroll-runs", undefined, marcus)).status).toBe(403);
    await grant("attendance", "manage");
    await grant("workforce_hr", "read");
    expect((await call("GET", "/workforce/hr/payroll-runs", undefined, marcus)).status).toBe(403);
  });
});
