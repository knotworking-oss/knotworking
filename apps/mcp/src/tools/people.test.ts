import { afterEach, describe, expect, it } from "vitest";
import { connect } from "../testing/harness";

type Session = Awaited<ReturnType<typeof connect>>;
const open: Session[] = [];
async function session(options: Parameters<typeof connect>[0] = {}) {
  const s = await connect(options);
  open.push(s);
  return s;
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

describe("people tools", () => {
  it("lists active staff by default, with role and status filters", async () => {
    const { call } = await session();
    const active = await call("list_staff", { workspace: "acme" });
    expect(active.data.staff.map((s: { staffNumber: string }) => s.staffNumber)).toEqual([
      "100001",
      "000042",
    ]);
    expect(active.data.staff[0]).toMatchObject({
      name: "Grace Hopper",
      jobRoles: ["Line operative"],
      hasKioskPin: true,
    });
    expect((await call("list_staff", { workspace: "acme", status: "all" })).data.total).toBe(3);
    const ops = await call("list_staff", { workspace: "acme", job_role: "line OPERATIVE" });
    expect(ops.data.staff.map((s: { name: string }) => s.name)).toEqual(["Grace Hopper"]);
    const missing = await call("list_staff", { workspace: "acme", job_role: "Astronaut" });
    expect(missing.isError).toBe(true);
  });

  it("creates staff with job roles by name, and never sends a PIN", async () => {
    const { call, fake } = await session();
    const created = await call("create_staff", {
      workspace: "acme",
      first_name: "Ada",
      last_name: "Lovelace",
      department: "Bakery",
      job_roles: ["First aider"],
    });
    expect(created.data).toMatchObject({
      staffNumber: "100003",
      jobRoles: ["First aider"],
      hasKioskPin: false,
    });
    expect(fake.peopleModule.staff).toHaveLength(4);
    expect(fake.requests.some((r: { path: string }) => r.path.endsWith("/pin"))).toBe(false);
    const dupe = await call("create_staff", {
      workspace: "acme",
      first_name: "X",
      last_name: "Y",
      staff_number: "000042",
    });
    expect(dupe.isError).toBe(true);
    expect(dupe.data.error.code).toBe("staff_number_taken");
  });

  it("updates by staff number and records leavers", async () => {
    const { call } = await session();
    const left = await call("update_staff", { workspace: "acme", staff: "000042", status: "leaver" });
    expect(left.data).toMatchObject({ name: "Alan Turing", status: "leaver", endDate: "2026-01-05" });
    const unknown = await call("update_staff", { workspace: "acme", staff: "999999", status: "leaver" });
    expect(unknown.data.error.code).toBe("not_found");
    const empty = await call("update_staff", { workspace: "acme", staff: "100001" });
    expect(empty.isError).toBe(true);
  });

  it("lists and creates job roles", async () => {
    const { call } = await session();
    const roles = await call("list_job_roles", { workspace: "acme" });
    expect(roles.data.jobRoles).toEqual([
      expect.objectContaining({ name: "Line operative", staffCount: 1 }),
      expect.objectContaining({ name: "First aider", staffCount: 0 }),
    ]);
    expect((await call("create_job_role", { workspace: "acme", name: "Hygiene" })).data.name).toBe("Hygiene");
    expect((await call("create_job_role", { workspace: "acme", name: "hygiene" })).data.error.code).toBe(
      "name_taken",
    );
  });
});

describe("staff CSV import tool", () => {
  it("checks, refuses a bad file, imports, and never reads a PIN column", async () => {
    const { call, fake } = await session();
    const csv =
      "staff number,first name,last name,department,PIN\n100050,Ada,Lovelace,Quality,123456\n100001,,,Packing,654321\n";
    const dry = await call("import_staff_csv", { workspace: "acme", csv, dry_run: true });
    expect(dry.data).toMatchObject({
      dryRun: true,
      rows: 2,
      created: 1,
      updated: 1,
      ignoredColumns: ["PIN"],
    });
    expect((await call("list_staff", { workspace: "acme", query: "Lovelace" })).data.total).toBe(0);

    const invalid = await call("import_staff_csv", { workspace: "acme", csv: "staff number\n12" });
    expect(invalid.isError).toBe(true);
    expect(invalid.data.error.code).toBe("invalid_rows");

    const done = await call("import_staff_csv", { workspace: "acme", csv });
    expect(done.data).toMatchObject({ dryRun: false, created: 1, updated: 1 });
    expect(fake.requests.some((r) => r.path.endsWith("/people/staff/import"))).toBe(true);
    expect((await call("list_staff", { workspace: "acme", query: "Lovelace" })).data.total).toBe(1);
    const tool = (await (await session()).client.listTools()).tools.find(
      (t) => t.name === "import_staff_csv",
    )!;
    expect(tool.description).toMatch(/PIN/);
  });
});
