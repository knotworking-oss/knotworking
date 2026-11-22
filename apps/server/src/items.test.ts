import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";

describe("items module", () => {
  let ctx: TestCtx;
  let ada: string;
  let marcus: { cookie: string; userId: string };
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

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    const { members } = await (await ctx.req(`${WS}/members`, { cookie: ada })).json();
    const m = members.find((x: { email: string }) => x.email === "marcus@knotworking.dev");
    marcus = { userId: m.userId, cookie: (await signIn(ctx, m.email)).cookie };
  }, 60_000);
  afterAll(() => ctx.handle.close());

  describe("access", () => {
    it("is opt-in: a member needs a grant, and read can't write", async () => {
      expect((await as(marcus.cookie).get("/items")).status).toBe(403);
      await grant("read");
      expect((await as(marcus.cookie).get("/items")).status).toBe(200);
      const write = await as(marcus.cookie).send("POST", "/items", {
        code: "X",
        name: "X",
        type: "ingredient",
        unit: "kg",
      });
      expect(write.status).toBe(403);
      await grant("write");
    });

    it("is switched off with the module", async () => {
      const off = await makeApp({ seed: true, activeModules: ["tasks", "docs"] });
      const cookie = (await signIn(off, "ada@knotworking.dev")).cookie;
      const res = await off.req(`${WS}/items`, { cookie });
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe("module_inactive");
      await off.handle.close();
    }, 60_000);
  });

  describe("suppliers", () => {
    let millId: string;

    it("creates, lists and updates suppliers; codes are unique case-insensitively", async () => {
      const created = await as(marcus.cookie).send("POST", "/suppliers", {
        name: "Shipton Mill",
        code: "SHIP",
        email: "orders@shipton.example",
        certification: "BRCGS Food Safety AA",
        certificateExpiresOn: "2027-03-31",
      });
      expect(created.status).toBe(201);
      const mill = await created.json();
      millId = mill.id;
      expect(mill).toMatchObject({
        name: "Shipton Mill",
        approvalStatus: "pending",
        approvalChangedBy: null,
      });
      expect(mill.workspaceId).toBeUndefined();

      const dupe = await as(ada).send("POST", "/suppliers", { name: "Other", code: "ship" });
      expect(dupe.status).toBe(409);
      expect((await dupe.json()).error.code).toBe("code_taken");

      const patched = await as(marcus.cookie).send("PATCH", `/suppliers/${millId}`, {
        phone: "01234 567890",
      });
      expect((await patched.json()).phone).toBe("01234 567890");
      expect((await as(ada).send("PATCH", `/suppliers/${millId}`, {})).status).toBe(400);
      expect((await as(ada).send("POST", "/suppliers", { name: "Bad", email: "nope" })).status).toBe(400);

      const { suppliers } = await (await as(ada).get("/suppliers?q=ship")).json();
      expect(suppliers.map((s: { name: string }) => s.name)).toEqual(["Shipton Mill"]);
      expect((await (await as(ada).get("/suppliers?status=approved")).json()).suppliers).toEqual([]);
    });

    it("approval needs manage and a signed-in person, and records who decided", async () => {
      const approval = { status: "approved", note: "Certificate checked", reviewDueOn: "2027-03-01" };
      // write is not enough…
      const asWriter = await as(marcus.cookie).send("POST", `/suppliers/${millId}/approval`, approval);
      expect(asWriter.status).toBe(403);
      expect((await asWriter.json()).error.code).toBe("module_forbidden");
      // …and an owner's API token is refused too.
      const { token } = await (
        await ctx.req("/v1/me/api-tokens", {
          method: "POST",
          cookie: ada,
          json: { name: "t", scope: "write" },
        })
      ).json();
      const viaToken = await ctx.req(`${WS}/suppliers/${millId}/approval`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, origin: "" },
        json: approval,
      });
      expect(viaToken.status).toBe(403);
      expect((await viaToken.json()).error.code).toBe("token_not_allowed");

      const ok = await as(ada).send("POST", `/suppliers/${millId}/approval`, approval);
      expect(ok.status).toBe(200);
      const supplier = await ok.json();
      const me = (await (await ctx.req("/v1/me", { cookie: ada })).json()).user.id;
      expect(supplier).toMatchObject({
        approvalStatus: "approved",
        approvalChangedBy: me,
        approvalNote: "Certificate checked",
        reviewDueOn: "2027-03-01",
      });
      expect(supplier.approvalChangedAt).toBeTruthy();

      // A member with manage may decide as well.
      await grant("manage");
      const suspended = await as(marcus.cookie).send("POST", `/suppliers/${millId}/approval`, {
        status: "suspended",
      });
      expect((await suspended.json()).approvalStatus).toBe("suspended");
      await grant("write");
    });
  });

  describe("items", () => {
    let flourId: string;
    let supplierId: string;

    beforeAll(async () => {
      supplierId = (await (await as(ada).send("POST", "/suppliers", { name: "Dairy Co" })).json()).id;
    });

    it("creates an item with allergens (sorted, deduplicated) and suppliers", async () => {
      const res = await as(marcus.cookie).send("POST", "/items", {
        code: "FLR-001",
        name: "Strong white flour",
        type: "ingredient",
        unit: "kg",
        allergens: ["cereals_gluten", "cereals_gluten"],
        mayContain: ["soybeans", "mustard"],
        shelfLifeDays: 270,
        standardCost: 0.82,
        suppliers: [{ supplierId, supplierCode: "D-77", preferred: true }],
      });
      expect(res.status).toBe(201);
      const item = await res.json();
      flourId = item.id;
      expect(item).toMatchObject({
        code: "FLR-001",
        status: "active",
        storage: "ambient",
        allergens: ["cereals_gluten"],
        mayContain: ["mustard", "soybeans"],
        standardCost: 0.82,
        suppliers: [{ supplierId, name: "Dairy Co", supplierCode: "D-77", preferred: true }],
      });
    });

    it("refuses duplicate codes, unknown allergens, suppliers and units", async () => {
      const base = { name: "X", type: "ingredient", unit: "kg" };
      const dupe = await as(ada).send("POST", "/items", { ...base, code: "flr-001" });
      expect(dupe.status).toBe(409);
      expect(
        (await as(ada).send("POST", "/items", { ...base, code: "A", allergens: ["gluten"] })).status,
      ).toBe(400);
      expect((await as(ada).send("POST", "/items", { ...base, code: "A", unit: "lb" })).status).toBe(400);
      const unknown = await as(ada).send("POST", "/items", {
        ...base,
        code: "A",
        suppliers: [{ supplierId: "00000000-0000-7000-8000-000000000000" }],
      });
      expect(unknown.status).toBe(400);
      // Nothing half-created.
      expect((await (await as(ada).get("/items?status=all")).json()).total).toBe(1);
    });

    it("updates fields, keeps the unit's dimension, and replaces supplier links", async () => {
      const patched = await as(marcus.cookie).send("PATCH", `/items/${flourId}`, {
        unit: "g",
        standardCost: null,
      });
      expect(await patched.json()).toMatchObject({ unit: "g", standardCost: null });
      const wrong = await as(ada).send("PATCH", `/items/${flourId}`, { unit: "l" });
      expect(wrong.status).toBe(409);
      expect((await wrong.json()).error.code).toBe("unit_dimension_fixed");

      const unlinked = await as(ada).send("PATCH", `/items/${flourId}`, { suppliers: [] });
      expect((await unlinked.json()).suppliers).toEqual([]);
      const relinked = await as(ada).send("PATCH", `/items/${flourId}`, { suppliers: [{ supplierId }] });
      expect((await relinked.json()).suppliers).toMatchObject([
        { supplierId, supplierCode: null, preferred: false },
      ]);
    });

    it("filters by type, allergen, supplier, status and text, with a total", async () => {
      await as(ada).send("POST", "/items", {
        code: "MLK-001",
        name: "Whole milk",
        type: "ingredient",
        unit: "l",
        allergens: ["milk"],
        storage: "chilled",
        densityGPerMl: 1.03,
      });
      await as(ada).send("POST", "/items", {
        code: "BOX-12",
        name: "Cake box 12in",
        type: "packaging",
        unit: "each",
      });
      const list = async (qs: string) =>
        (await (await as(ada).get(`/items?${qs}`)).json()) as { items: any[]; total: number };
      expect((await list("")).total).toBe(3);
      expect((await list("type=packaging")).items.map((i) => i.code)).toEqual(["BOX-12"]);
      expect((await list("allergen=milk")).items.map((i) => i.code)).toEqual(["MLK-001"]);
      expect((await list("allergen=mustard")).items.map((i) => i.code)).toEqual(["FLR-001"]);
      expect((await list(`supplierId=${supplierId}`)).items.map((i) => i.code)).toEqual(["FLR-001"]);
      expect((await list("q=box")).items.map((i) => i.code)).toEqual(["BOX-12"]);
      expect((await list("q=100%25")).total).toBe(0);
      const page = await list("limit=1&offset=1");
      expect(page.items).toHaveLength(1);
      expect(page.total).toBe(3);

      await as(ada).send("PATCH", `/items/${flourId}`, { status: "archived" });
      expect((await list("")).total).toBe(2);
      expect((await list("status=all")).total).toBe(3);
      expect((await list("status=archived")).items.map((i) => i.code)).toEqual(["FLR-001"]);
    });

    it("writes the sync log, hidden from members without the module", async () => {
      const sync = async (cookie: string) =>
        (await (await ctx.req(`${WS}/sync?after=0&limit=1000`, { cookie })).json()).changes.map(
          (c: { entity: string }) => c.entity,
        ) as string[];
      const seen = await sync(ada);
      for (const entity of ["item", "supplier", "item_supplier"]) expect(seen).toContain(entity);
      await grant("none");
      const hidden = await sync(marcus.cookie);
      for (const entity of ["item", "supplier", "item_supplier"]) expect(hidden).not.toContain(entity);
      await grant("write");
    });

    it("deletes an item with its links; deleting a supplier unlinks it from items", async () => {
      const { id } = await (
        await as(ada).send("POST", "/items", {
          code: "TMP",
          name: "Temp",
          type: "wip",
          unit: "kg",
          suppliers: [{ supplierId }],
        })
      ).json();
      expect((await as(ada).send("DELETE", `/items/${id}`)).status).toBe(204);
      expect((await as(ada).get(`/items/${id}`)).status).toBe(404);
      // The code is free again.
      expect(
        (await as(ada).send("POST", "/items", { code: "TMP", name: "Temp 2", type: "wip", unit: "kg" }))
          .status,
      ).toBe(201);

      expect((await as(ada).send("DELETE", `/suppliers/${supplierId}`)).status).toBe(204);
      expect((await (await as(ada).get(`/items/${flourId}`)).json()).suppliers).toEqual([]);
      expect((await as(ada).get(`/suppliers/${supplierId}`)).status).toBe(404);
    });
  });
});
