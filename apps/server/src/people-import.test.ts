import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";

describe("staff CSV import", () => {
  let ctx: TestCtx;
  let ada: string;
  let adaUserId: string;
  let marcus: { cookie: string; userId: string };
  let token: string;
  const as = (cookie: string) => ({
    get: (path: string) => ctx.req(`${WS}${path}`, { cookie }),
    send: (method: string, path: string, json?: unknown) => ctx.req(`${WS}${path}`, { method, cookie, json }),
  });
  const grant = (level: string | null) =>
    ctx.req(`${WS}/members/${marcus.userId}/module-access/people`, {
      method: "PUT",
      cookie: ada,
      json: { level },
    });
  const run = (csv: string, dryRun = false, cookie = ada) =>
    as(cookie).send("POST", "/people/staff/import", { csv, dryRun, fileName: "staff.csv" });
  const staffList = async () =>
    (await (await as(ada).get("/people/staff?status=all&limit=500")).json()).staff as any[];
  const byNumber = async (n: string) => (await staffList()).find((s) => s.staffNumber === n);
  const role = async (name: string) =>
    (await (await as(ada).send("POST", "/people/job-roles", { name })).json()).id as string;

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    const { members } = await (await ctx.req(`${WS}/members`, { cookie: ada })).json();
    adaUserId = members.find((x: { email: string }) => x.email === "ada@knotworking.dev").userId;
    const m = members.find((x: { email: string }) => x.email === "marcus@knotworking.dev");
    marcus = { userId: m.userId, cookie: (await signIn(ctx, m.email)).cookie };
    token = (
      await (
        await ctx.req("/v1/me/api-tokens", {
          method: "POST",
          cookie: ada,
          json: { name: "importer", scope: "write" },
        })
      ).json()
    ).token;
    await role("Line operative");
    await role("Hygiene");
    const archived = await role("Old role");
    await as(ada).send("PATCH", `/people/job-roles/${archived}`, { status: "archived" });
  }, 60_000);
  afterAll(() => ctx.handle.close());

  it("needs write on people, and takes API tokens", async () => {
    expect((await run("staff number\n100001", true, marcus.cookie)).status).toBe(403);
    await grant("read");
    expect((await run("staff number\n100001", true, marcus.cookie)).status).toBe(403);
    await grant("write");
    expect((await run("staff number,first name,last name\n100001,A,B", true, marcus.cookie)).status).toBe(
      200,
    );
    const res = await ctx.req(`${WS}/people/staff/import`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, origin: "" },
      json: { csv: "staff number,first name,last name\n190001,Via,Token" },
    });
    expect(res.status).toBe(201);
  });

  it("previews, then creates people with their job roles", async () => {
    const csv = [
      "Staff number,First name,Last name,Department,Job roles,Start date,Payroll reference",
      '100001,Ada,Lovelace,Production,"Line operative; hygiene",05/01/2026,E1',
      "100002,Grace,Hopper,Packing,,2026-02-01,",
    ].join("\n");
    const before = (await staffList()).length;
    const dry = await (await run(csv, true)).json();
    expect(dry).toMatchObject({ dryRun: true, rowCount: 2, created: 2, errors: [] });
    expect(dry.changes[0]).toMatchObject({ key: "100001", name: "Ada Lovelace", action: "create" });
    expect(await staffList()).toHaveLength(before);

    expect((await run(csv)).status).toBe(201);
    const ada1 = await byNumber("100001");
    expect(ada1).toMatchObject({
      firstName: "Ada",
      department: "Production",
      startDate: "2026-01-05",
      payrollReference: "E1",
      status: "active",
      hasPin: false,
    });
    expect(ada1.jobRoles.map((r: any) => r.name).sort()).toEqual(["Hygiene", "Line operative"]);
    const sync = await (await ctx.req(`${WS}/sync?after=0&limit=1000`, { cookie: ada })).json();
    expect(sync.changes.map((c: any) => c.entity)).toEqual(
      expect.arrayContaining(["staff", "staff_job_role"]),
    );
  });

  it("updates by staff number, changing only what the file says", async () => {
    const same = await (
      await run(
        "staff number,first name,department,job roles\n100001,Ada,Production,Hygiene; Line operative",
        true,
      )
    ).json();
    expect(same).toMatchObject({ created: 0, updated: 0, unchanged: 1 });

    const res = await (
      await run("staff number,department,job roles,start date\n100001,Quality,Hygiene,\n100002,Packing,,")
    ).json();
    expect(res).toMatchObject({ created: 0, updated: 2 });
    expect(res.changes[0].fields.sort()).toEqual(["department", "jobRoles", "startDate"]);
    expect(await byNumber("100001")).toMatchObject({
      firstName: "Ada",
      lastName: "Lovelace",
      department: "Quality",
      startDate: null,
      payrollReference: "E1",
    });
    expect((await byNumber("100001")).jobRoles.map((r: any) => r.name)).toEqual(["Hygiene"]);
    // 100002 had a start date; the empty cell cleared it.
    expect((await byNumber("100002")).startDate).toBeNull();
  });

  it("marks a leaver with today's date, and back to active clears it", async () => {
    await run("staff number,status\n100002,leaver");
    const leaver = await byNumber("100002");
    expect(leaver.status).toBe("leaver");
    expect(leaver.endDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await run("staff number,status\n100002,active");
    expect(await byNumber("100002")).toMatchObject({ status: "active", endDate: null });
  });

  it("never reads a PIN: the column is ignored and an existing PIN stays", async () => {
    const id = (await byNumber("100001")).id;
    expect((await as(ada).send("PUT", `/people/staff/${id}/pin`, { pin: "482915" })).status).toBe(200);
    const dry = await (
      await run("staff number,first name,PIN,Kiosk PIN\n100001,Ada,111222,333444", true)
    ).json();
    expect(dry).toMatchObject({ unchanged: 1, ignoredColumns: ["PIN", "Kiosk PIN"] });
    await run("staff number,department,PIN\n100001,Goods in,111222");
    expect(await byNumber("100001")).toMatchObject({ department: "Goods in", hasPin: true });
  });

  it("keeps the number fixed for people with records: the number is the key", async () => {
    // Give 100001 attendance history, then import: updates work and the number can't change.
    const person = await byNumber("100001");
    const event = await as(ada).send("POST", "/attendance/events", {
      staffId: person.id,
      kind: "in",
      at: "2026-03-09T08:00:00Z",
      reason: "Forgot",
    });
    expect(event.status).toBe(201);
    const res = await run("staff number,first name,last name\n100001,Ada,Byron");
    expect(res.status).toBe(201);
    expect(await byNumber("100001")).toMatchObject({ id: person.id, lastName: "Byron" });
    // A different number is a different person (it never renames the old one).
    const other = await (await run("staff number,first name,last name\n100009,Ada,Byron")).json();
    expect(other.created).toBe(1);
    expect((await byNumber("100001")).id).toBe(person.id);
  });

  it("checks every row and writes nothing when any is wrong", async () => {
    await as(ada).send("DELETE", `/people/staff/${(await byNumber("100009")).id}`);
    const before = await staffList();
    const csv = [
      "staff number,first name,last name,job roles,start date,end date",
      "100020,Fine,Person,,,",
      "100021,,Nameless,,,", // a new person needs a first name
      "100022,Roly,Poly,Astronaut,,", // unknown role
      "100023,Roly,Poly,Old role,,", // archived role
      "100009,Gone,Person,,,", // removed number
      "100024,Back,Wards,,2026-05-01,2026-01-01",
      "1234,Short,Number,,,",
    ].join("\n");
    const dry = await (await run(csv, true)).json();
    expect(dry.errors.map((e: any) => [e.row, e.column])).toEqual([
      [3, "firstName"],
      [4, "jobRoles"],
      [5, "jobRoles"],
      [6, "staffNumber"],
      [7, "endDate"],
      [8, "staffNumber"],
    ]);
    expect(dry.errors[3].message).toContain("never reused");
    const res = await run(csv);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_rows");
    expect(await staffList()).toHaveLength(before.length);
  });

  it("is switched off with the module", async () => {
    const off = await makeApp({ seed: true, activeModules: ["tasks", "docs"] });
    const cookie = (await signIn(off, "ada@knotworking.dev")).cookie;
    const res = await off.req(`${WS}/people/staff/import`, { method: "POST", cookie, json: { csv: "a\n1" } });
    expect(res.status).toBe(404);
    await off.handle.close();
  }, 60_000);

  it("does not link staff to logins", async () => {
    const dry = await (
      await run("staff number,first name,last name,user id\n100030,A,B," + adaUserId, true)
    ).json();
    expect(dry.ignoredColumns).toEqual(["user id"]);
  });
});
