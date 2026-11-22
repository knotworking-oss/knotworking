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

describe("specification tools", () => {
  it("lists specifications with their approved version and review state", async () => {
    const { call } = await session();
    const page = await call("list_specifications", { workspace: "acme" });
    expect(page.data).toMatchObject({ total: 1, returned: 1, hasMore: false });
    expect(page.data.specifications[0]).toMatchObject({
      code: "SPEC-FLR-SHIP",
      kind: "ingredient",
      party: "supplier",
      item: "FLR-001",
      supplier: "Shipton Mill",
      approvedVersion: 1,
      reviewState: "due_soon",
      draftVersion: null,
    });
    expect((await call("list_specifications", { workspace: "acme", item: "flr-001" })).data.total).toBe(1);
    expect((await call("list_specifications", { workspace: "acme", supplier: "SHIP" })).data.total).toBe(1);
    expect((await call("list_specifications", { workspace: "acme", kind: "packaging" })).data.total).toBe(0);
    expect((await call("list_specifications", { workspace: "acme", review: "attention" })).data.total).toBe(
      1,
    );
  });

  it("gets one by code with item discrepancies and, on request, its impact", async () => {
    const { call } = await session();
    const got = await call("get_specification", { workspace: "acme", specification: "spec-flr-ship" });
    expect(got.data).toMatchObject({
      code: "SPEC-FLR-SHIP",
      approvedVersion: { versionNumber: 1, mayContainNames: ["Sesame"], agreement: { by: "R. Shipton" } },
      draft: null,
    });
    // The flour item doesn't mention sesame.
    expect(got.data.itemDiscrepancies.map((d: { kind: string }) => d.kind)).toEqual([
      "may_contain_undeclared",
    ]);
    expect(got.data.approvalNote).toMatch(/no tool/);
    expect(got.data.impact).toBeUndefined();
    const withImpact = await call("get_specification", {
      workspace: "acme",
      specification: "SPEC-FLR-SHIP",
      include_impact: true,
    });
    expect(withImpact.data.impact.recipes).toEqual([
      { code: "SPONGE", name: "Victoria sponge", relation: "ingredient", depth: 1, makes: "BOX-12" },
    ]);
    expect(withImpact.data.impact.openBatches).toBeNull();
    expect(withImpact.data.impact.hidden).toEqual(["production"]);
    const missing = await call("get_specification", { workspace: "acme", specification: "NOPE" });
    expect(missing.isError).toBe(true);
  });

  it("drafts a revision, keeping fields that aren't given", async () => {
    const { call } = await session();
    const saved = await call("save_specification_draft", {
      workspace: "acme",
      specification: "SPEC-FLR-SHIP",
      shelf_life_days: 240,
      review_due_on: "2027-01-01",
      change_note: "Shorter life from the new mill",
    });
    expect(saved.data.draft).toMatchObject({
      versionNumber: 2,
      shelfLifeDays: 240,
      storage: "ambient",
      mayContain: ["sesame"],
      agreement: { by: "R. Shipton" },
      changeNote: "Shorter life from the new mill",
      blockers: [],
    });
    expect(saved.data.draft.parameters).toEqual([expect.objectContaining({ name: "Moisture", max: 15.5 })]);
    expect(saved.data.draft.changes.fields.map((f: { field: string }) => f.field)).toEqual(["shelfLifeDays"]);
    // Saving again replaces the parameters only when given.
    const again = await call("save_specification_draft", {
      workspace: "acme",
      specification: "SPEC-FLR-SHIP",
      parameters: [{ category: "microbiological", name: "Salmonella", limit_text: "Absent in 25 g" }],
    });
    expect(again.data.draft.shelfLifeDays).toBe(240);
    expect(again.data.draft.parameters.map((p: { name: string }) => p.name)).toEqual(["Salmonella"]);
  });

  it("creates a specification with a first draft and reports what blocks approval", async () => {
    const { call } = await session();
    const created = await call("create_specification", {
      workspace: "acme",
      code: "SPEC-BOX",
      title: "Cake box",
      item: "BOX-12",
      supplier: "Dairy Co",
      review_due_on: "2027-01-01",
    });
    expect(created.data).toMatchObject({ code: "SPEC-BOX", kind: "packaging", party: "supplier" });
    expect(created.data.draft.blockers).toEqual([
      "Describe the packaging: material and food-contact compliance",
      "Record the supplier's agreement (who and when)",
    ]);
    const dup = await call("create_specification", {
      workspace: "acme",
      code: "spec-box",
      title: "x",
      item: "BOX-12",
    });
    expect(dup.isError).toBe(true);
  });

  it("has no tool to approve", async () => {
    const { client } = await session();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "list_specifications",
        "get_specification",
        "create_specification",
        "save_specification_draft",
      ]),
    );
    expect(names.some((n) => n.includes("approve_specification"))).toBe(false);
  });
});
