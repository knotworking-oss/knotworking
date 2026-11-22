import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";

describe("items and suppliers CSV import", () => {
  let ctx: TestCtx;
  let ada: string;
  let marcus: { cookie: string; userId: string };
  let token: string;
  const as = (cookie: string) => ({
    get: (path: string) => ctx.req(`${WS}${path}`, { cookie }),
    send: (method: string, path: string, json?: unknown) => ctx.req(`${WS}${path}`, { method, cookie, json }),
  });
  const grant = (level: string | null) =>
    ctx.req(`${WS}/members/${marcus.userId}/module-access/items`, {
      method: "PUT",
      cookie: ada,
      json: { level },
    });
  const importItems = (csv: string, dryRun = false, cookie = ada) =>
    as(cookie).send("POST", "/items/import", { csv, dryRun, fileName: "items.csv" });
  const importSuppliers = (csv: string, dryRun = false, cookie = ada) =>
    as(cookie).send("POST", "/suppliers/import", { csv, dryRun });
  const listItems = async (query = "status=all") =>
    (await (await as(ada).get(`/items?${query}&limit=200`)).json()).items as any[];
  const listSuppliers = async () => (await (await as(ada).get("/suppliers")).json()).suppliers as any[];
  const syncEntities = async () =>
    (await (await ctx.req(`${WS}/sync?after=0&limit=1000`, { cookie: ada })).json()).changes.map(
      (c: { entity: string }) => c.entity,
    ) as string[];

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    const { members } = await (await ctx.req(`${WS}/members`, { cookie: ada })).json();
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
  }, 60_000);
  afterAll(() => ctx.handle.close());

  describe("access", () => {
    it("needs write on items; read can check nothing", async () => {
      expect((await importItems("code\nA", true, marcus.cookie)).status).toBe(403);
      await grant("read");
      expect((await importItems("code,name,type,unit\nA,a,ingredient,kg", true, marcus.cookie)).status).toBe(
        403,
      );
      expect((await importSuppliers("name\nA", true, marcus.cookie)).status).toBe(403);
      await grant("write");
      expect((await importItems("code,name,type,unit\nA,a,ingredient,kg", true, marcus.cookie)).status).toBe(
        200,
      );
    });

    it("takes API tokens, like the demand import", async () => {
      const res = await ctx.req(`${WS}/items/import`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, origin: "" },
        json: { csv: "code,name,type,unit\nTOK-1,Via token,ingredient,kg" },
      });
      expect(res.status).toBe(201);
      const sup = await ctx.req(`${WS}/suppliers/import`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, origin: "" },
        json: { csv: "name\nToken Supplies" },
      });
      expect(sup.status).toBe(201);
    });

    it("is switched off with the module", async () => {
      const off = await makeApp({ seed: true, activeModules: ["tasks", "docs"] });
      const cookie = (await signIn(off, "ada@knotworking.dev")).cookie;
      const res = await off.req(`${WS}/items/import`, { method: "POST", cookie, json: { csv: "code\nA" } });
      expect(res.status).toBe(404);
      await off.handle.close();
    }, 60_000);
  });

  describe("items", () => {
    const csv = [
      "Stock code,Name,Type,Unit,Contains,May contain,Storage,Shelf life,Standard cost,Density",
      'FLR-01,Plain flour,ingredient,kg,Gluten,"Milk; Eggs",Ambient,365,0.85,',
      "MLK-01,Whole milk,ingredient,l,Milk,,Chilled,7,£0.90,1.03",
      "BOX-01,Cake box,packaging,each,,,,,0.12,",
    ].join("\n");

    it("previews without writing, then creates every row", async () => {
      const before = await listItems();
      const dry = await (await importItems(csv, true)).json();
      expect(dry).toMatchObject({
        dryRun: true,
        rowCount: 3,
        created: 3,
        updated: 0,
        unchanged: 0,
        errors: [],
      });
      expect(dry.changes[0]).toMatchObject({ row: 2, action: "create", key: "FLR-01", name: "Plain flour" });
      expect(await listItems()).toHaveLength(before.length);

      const res = await importItems(csv);
      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({ dryRun: false, created: 3 });
      const flour = (await listItems("q=FLR-01"))[0];
      expect(flour).toMatchObject({
        name: "Plain flour",
        type: "ingredient",
        unit: "kg",
        allergens: ["cereals_gluten"],
        mayContain: ["eggs", "milk"],
        storage: "ambient",
        shelfLifeDays: 365,
        standardCost: 0.85,
        status: "active",
      });
      expect((await listItems("q=MLK-01"))[0]).toMatchObject({
        storage: "chilled",
        standardCost: 0.9,
        densityGPerMl: 1.03,
      });
      expect(await syncEntities()).toContain("item");
    });

    it("updates by stock code, ignoring case, and leaves unchanged rows alone", async () => {
      const again = await (await importItems(csv, true)).json();
      expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 3 });

      const res = await (
        await importItems(
          [
            "code,standard cost,allergens,shelf life",
            "flr-01,0.95,,", // clears allergens (empty cell = none) and shelf life
            "box-01,0.12,,", // nothing changes
          ].join("\n"),
        )
      ).json();
      expect(res).toMatchObject({ created: 0, updated: 1, unchanged: 1 });
      expect(res.changes[0]).toMatchObject({ action: "update", key: "flr-01" });
      expect(res.changes[0].fields.sort()).toEqual(["allergens", "shelfLifeDays", "standardCost"]);
      const flour = (await listItems("q=FLR-01"))[0];
      expect(flour).toMatchObject({
        code: "FLR-01",
        name: "Plain flour",
        standardCost: 0.95,
        allergens: [],
        mayContain: ["eggs", "milk"],
        shelfLifeDays: null,
      });
    });

    it("lists every problem and writes nothing when any row is wrong", async () => {
      const before = (await listItems()).length;
      const bad = [
        "code,name,type,unit,allergens",
        "NEW-1,Fine,ingredient,kg,",
        "NEW-2,,ingredient,kg,", // a new item needs a name
        "MLK-01,Milk,ingredient,kg,", // volume item to mass
        "NEW-3,Three,widget,kg,",
        "NEW-4,Four,ingredient,kg,kale",
        "new-1,Dup,ingredient,kg,",
      ].join("\n");
      const dry = await (await importItems(bad, true)).json();
      expect(dry.errors.map((e: any) => [e.row, e.column])).toEqual([
        [3, "name"],
        [4, "unit"],
        [5, "type"],
        [6, "allergens"],
        [7, "code"],
      ]);
      expect(dry.created).toBe(0);

      const res = await importItems(bad);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("invalid_rows");
      expect(body.error.details.errors).toHaveLength(5);
      expect(await listItems()).toHaveLength(before);
    });

    it("is all or nothing when a later write fails", async () => {
      // Fine row first; the run is checked as a whole before any write.
      const before = await listItems("q=ZZ-");
      const res = await importItems("code,name,type,unit\nZZ-1,Ok,ingredient,kg\nZZ-2,,ingredient,kg");
      expect(res.status).toBe(400);
      expect(await listItems("q=ZZ-")).toHaveLength(before.length);
    });

    it("reports a missing code column and an empty file", async () => {
      expect((await (await importItems("name,type\nx,y", true)).json()).errors[0]).toMatchObject({
        row: 1,
        column: "code",
      });
      expect((await importItems("   ", true)).status).toBe(200);
    });
  });

  describe("suppliers", () => {
    it("creates suppliers as pending and reports ignored approval columns", async () => {
      const csv = [
        "Code,Supplier,Contact,Email,Phone,Certification,Certificate expiry,Approval status",
        "MILL01,Eastern Mills,Sam Baker,orders@mills.example,01234,BRCGS AA,31/03/2027,approved",
        ",No Code Ltd,,,,,,",
      ].join("\n");
      const dry = await (await importSuppliers(csv, true)).json();
      expect(dry).toMatchObject({ created: 2, ignoredColumns: ["Approval status"], errors: [] });
      const res = await importSuppliers(csv);
      expect(res.status).toBe(201);
      const mill = (await listSuppliers()).find((s) => s.code === "MILL01");
      expect(mill).toMatchObject({
        name: "Eastern Mills",
        contactName: "Sam Baker",
        certificateExpiresOn: "2027-03-31",
        approvalStatus: "pending",
        approvalChangedBy: null,
      });
      expect(await syncEntities()).toContain("supplier");
    });

    it("updates by code or name and never touches an existing approval", async () => {
      const mill = (await listSuppliers()).find((s) => s.code === "MILL01");
      const approved = await as(ada).send("POST", `/suppliers/${mill.id}/approval`, {
        status: "approved",
        note: "Checked",
        reviewDueOn: "2027-03-01",
      });
      expect(approved.status).toBe(200);

      const res = await (
        await importSuppliers(
          [
            "code,name,phone,approval status,reviewDueOn",
            "mill01,,09999,rejected,2030-01-01", // by code, case-insensitive; name kept
            ",no code ltd,0777,,", // by name
          ].join("\n"),
        )
      ).json();
      expect(res).toMatchObject({ created: 0, updated: 2 });
      const after = await listSuppliers();
      expect(after.find((s) => s.code === "MILL01")).toMatchObject({
        name: "Eastern Mills",
        phone: "09999",
        approvalStatus: "approved",
        approvalNote: "Checked",
        reviewDueOn: "2027-03-01",
      });
      expect(after.find((s) => s.name === "No Code Ltd")).toMatchObject({ phone: "0777" });
    });

    it("gives a name-matched supplier its code, and renames by code", async () => {
      await importSuppliers("code,name\nNC1,No Code Ltd");
      expect((await listSuppliers()).find((s) => s.code === "NC1")).toMatchObject({ name: "No Code Ltd" });
      await importSuppliers("code,name\nNC1,No Code Limited");
      expect((await listSuppliers()).find((s) => s.code === "NC1")).toMatchObject({
        name: "No Code Limited",
      });
      expect((await listSuppliers()).filter((s) => s.name.startsWith("No Code"))).toHaveLength(1);
    });

    it("refuses ambiguous, conflicting and incomplete rows without writing", async () => {
      await importSuppliers("name\nTwin\nTwin 2");
      const twins = await listSuppliers();
      await as(ada).send("PATCH", `/suppliers/${twins.find((s) => s.name === "Twin 2").id}`, {
        name: "Twin",
      });
      const before = (await listSuppliers()).length;
      const csv = [
        "code,name,email",
        ",Twin,", // two suppliers are called Twin
        "MILL01,Other name,", // fine: a rename
        "NEWCODE,,", // unknown code and no name
        "NC1,,bad-email",
        "ZZ9,No Code Limited,", // that name belongs to NC1
      ].join("\n");
      const dry = await (await importSuppliers(csv, true)).json();
      expect(dry.errors.map((e: any) => [e.row, e.column])).toEqual([
        [2, "name"],
        [4, "name"],
        [5, "email"],
        [6, "code"],
      ]);
      expect((await importSuppliers(csv)).status).toBe(400);
      expect(await listSuppliers()).toHaveLength(before);
    });

    it("refuses two rows for the same supplier", async () => {
      const dry = await (await importSuppliers("code,name\nMILL01,\n,Eastern Mills", true)).json();
      expect(dry.errors).toHaveLength(1);
      expect(dry.errors[0]).toMatchObject({ row: 3, column: "name" });
      expect(dry.errors[0].message).toContain("row 2");
    });
  });
});
