import { afterEach, describe, expect, it } from "vitest";
import { READ_TOKEN } from "../testing/fake-api";
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

describe("items tools", () => {
  it("lists active items by default, with filters and paging fields", async () => {
    const { call } = await session();
    const all = await call("list_items", { workspace: "acme" });
    expect(all.data.items.map((i: { code: string }) => i.code)).toEqual(["FLR-001", "MLK-001", "BOX-12"]);
    expect(all.data).toMatchObject({ total: 3, returned: 3, hasMore: false });
    expect((await call("list_items", { workspace: "acme", status: "all" })).data.total).toBe(4);
    const milk = await call("list_items", { workspace: "acme", allergen: "milk" });
    expect(milk.data.items.map((i: { code: string }) => i.code)).toEqual(["MLK-001"]);
    const bySupplier = await call("list_items", { workspace: "acme", supplier: "ship" });
    expect(bySupplier.data.items.map((i: { code: string }) => i.code)).toEqual(["FLR-001"]);
    const page = await call("list_items", { workspace: "acme", limit: 2 });
    expect(page.data).toMatchObject({ returned: 2, hasMore: true });
    expect((await call("list_items", { workspace: "acme", allergen: "gluten" })).isError).toBe(true);
  });

  it("gets an item by code (any case) or id, with allergen names and supplier approval", async () => {
    const { call, fake } = await session();
    const byCode = await call("get_item", { workspace: "acme", item: "flr-001" });
    expect(byCode.data).toMatchObject({
      code: "FLR-001",
      allergens: ["cereals_gluten"],
      allergenNames: ["Cereals containing gluten"],
      suppliers: [{ name: "Shipton Mill", approvalStatus: "approved" }],
    });
    const id = fake.itemsModule.items[1]!.id;
    expect((await call("get_item", { workspace: "acme", item: id })).data.code).toBe("MLK-001");
    const missing = await call("get_item", { workspace: "acme", item: "NOPE" });
    expect(missing.isError).toBe(true);
    expect(missing.data.error.code).toBe("not_found");
  });

  it("creates an item, resolving suppliers by name, and reports a taken code", async () => {
    const { call, fake } = await session();
    const created = await call("create_item", {
      workspace: "acme",
      code: "BUT-001",
      name: "Unsalted butter",
      type: "ingredient",
      unit: "kg",
      allergens: ["milk"],
      storage: "chilled",
      shelf_life_days: 60,
      suppliers: ["Dairy Co"],
    });
    expect(created.isError).toBe(false);
    expect(created.data).toMatchObject({
      code: "BUT-001",
      allergens: ["milk"],
      shelfLifeDays: 60,
      suppliers: [{ name: "Dairy Co", approvalStatus: "pending" }],
    });
    expect(fake.itemsModule.items.at(-1)).toMatchObject({ code: "BUT-001", storage: "chilled" });

    const dupe = await call("create_item", {
      workspace: "acme",
      code: "flr-001",
      name: "x",
      type: "ingredient",
      unit: "kg",
    });
    expect(dupe.data.error.code).toBe("code_taken");
    const unknown = await call("create_item", {
      workspace: "acme",
      code: "Z",
      name: "z",
      type: "ingredient",
      unit: "kg",
      suppliers: ["Nobody Ltd"],
    });
    expect(unknown.data.error.code).toBe("not_found");
    expect(fake.itemsModule.items.some((i) => i.code === "Z")).toBe(false);
  });

  it("updates only what was passed, and archives instead of deleting", async () => {
    const { call, fake, client } = await session();
    const res = await call("update_item", {
      workspace: "acme",
      item: "BOX-12",
      status: "archived",
      standard_cost: 0.4,
    });
    expect(res.data).toMatchObject({ status: "archived", standardCost: 0.4, name: "Cake box" });
    const patch = fake.requests.findLast((r) => r.method === "PATCH")!;
    expect(patch.path).toMatch(/\/items\//);
    expect((await call("update_item", { workspace: "acme", item: "BOX-12" })).data.error.code).toBe(
      "invalid_input",
    );
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("delete_item");
  });

  it("lists, creates and updates suppliers, but has no approval tool", async () => {
    const { call, client } = await session();
    const list = await call("list_suppliers", { workspace: "acme", status: "approved" });
    expect(list.data.suppliers).toMatchObject([
      { name: "Shipton Mill", itemCount: 1, reviewDueOn: "2027-03-01" },
    ]);
    const created = await call("create_supplier", {
      workspace: "acme",
      name: "Egg Farm",
      certification: "SALSA",
      certificate_expires_on: "2027-01-31",
    });
    expect(created.data).toMatchObject({
      name: "Egg Farm",
      approvalStatus: "pending",
      certification: "SALSA",
    });
    const updated = await call("update_supplier", {
      workspace: "acme",
      supplier: "egg farm",
      phone: "01234",
    });
    expect(updated.data.phone).toBe("01234");
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names.some((n) => /approv/.test(n))).toBe(false);
    const tool = (await client.listTools()).tools.find((t) => t.name === "create_supplier")!;
    expect(tool.description).toMatch(/person does in the app/);
  });

  it("write tools are refused for a read-only token; read tools work", async () => {
    const { call } = await session({ token: READ_TOKEN });
    expect((await call("list_items", { workspace: "acme" })).isError).toBe(false);
    const res = await call("create_supplier", { workspace: "acme", name: "X" });
    expect(res.data.error.code).toBe("token_read_only");
  });
});

describe("items CSV import tools", () => {
  it("checks items with a dry run, refuses a bad file, then imports", async () => {
    const { call, fake } = await session();
    const csv = "code,name,type,unit,allergens\nNEW-1,Rye flour,ingredient,kg,gluten\nflr-001,,,,\n";
    const dry = await call("import_items_csv", { workspace: "acme", csv, dry_run: true });
    expect(dry.data).toMatchObject({ dryRun: true, rows: 2, created: 1, updated: 1, errors: [] });
    expect(dry.data.changes[0]).toMatchObject({ row: 2, action: "create", key: "NEW-1" });
    expect((await call("list_items", { workspace: "acme", query: "NEW-1" })).data.total).toBe(0);

    const invalid = await call("import_items_csv", { workspace: "acme", csv: "code,type\nX,widget" });
    expect(invalid.isError).toBe(true);
    expect(invalid.data.error.code).toBe("invalid_rows");

    const done = await call("import_items_csv", { workspace: "acme", csv, file_name: "items.csv" });
    expect(done.isError).toBeFalsy();
    expect(done.data).toMatchObject({ dryRun: false, created: 1 });
    expect(fake.requests.some((r) => r.path.endsWith("/items/import"))).toBe(true);
    expect((await call("list_items", { workspace: "acme", query: "NEW-1" })).data.total).toBe(1);
  });

  it("imports suppliers, ignoring any approval column", async () => {
    const { call } = await session();
    const csv = "name,code,approval status\nNew Mill,NM1,approved\n";
    const dry = await call("import_suppliers_csv", { workspace: "acme", csv, dry_run: true });
    expect(dry.data).toMatchObject({ created: 1, ignoredColumns: ["approval status"] });
    await call("import_suppliers_csv", { workspace: "acme", csv });
    const listed = await call("list_suppliers", { workspace: "acme", query: "NM1" });
    expect(listed.data.suppliers[0]).toMatchObject({ name: "New Mill", approvalStatus: "pending" });
  });

  it("is refused for a read-only token", async () => {
    const { call } = await session({ token: READ_TOKEN });
    const res = await call("import_items_csv", { workspace: "acme", csv: "code\nA", dry_run: true });
    expect(res.data.error.code).toBe("token_read_only");
  });
});
