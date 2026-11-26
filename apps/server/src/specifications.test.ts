import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";

/** A complete ingredient draft: approvable once the supplier's agreement is recorded. */
const flourDraft = (over: Record<string, unknown> = {}) => ({
  description: "Wheat flour, type 55",
  storage: "ambient",
  shelfLifeDays: 270,
  minimumLifeOnReceiptDays: 120,
  allergens: ["cereals_gluten"],
  mayContain: [],
  countryOfOrigin: "United Kingdom",
  claims: [],
  parameters: [
    { category: "chemical", name: "Moisture", unit: "%", max: 15.5, method: "ISO 712" },
    { category: "microbiological", name: "Salmonella", limitText: "Absent in 25 g" },
  ],
  reviewDueOn: "2099-01-01",
  agreedBy: "J. Miller, Technical Manager",
  agreedOn: "2026-01-10",
  agreementReference: "MILL-SPEC-12 issue 4",
  changeNote: "First issue",
  ...over,
});

describe("specifications module", () => {
  let ctx: TestCtx;
  let ada: string;
  let marcus: { cookie: string; userId: string };
  let token: string;
  const as = (cookie: string) => ({
    get: (path: string) => ctx.req(`${WS}${path}`, { cookie }),
    send: (method: string, path: string, json?: unknown) => ctx.req(`${WS}${path}`, { method, cookie, json }),
  });
  const viaToken = (method: string, path: string, json?: unknown) =>
    ctx.req(`${WS}${path}`, { method, headers: { authorization: `Bearer ${token}`, origin: "" }, json });
  const ok = async (res: Response, status = 200): Promise<any> => {
    const body = (await res.json()) as any;
    expect(res.status, JSON.stringify(body)).toBe(status);
    return body;
  };
  const fails = async (res: Response, status: number, code?: string): Promise<any> => {
    const body = (await res.json()) as any;
    expect(res.status, JSON.stringify(body)).toBe(status);
    if (code) expect(body.error?.code ?? body.code).toBe(code);
    return body;
  };
  const grant = async (moduleId: string, level: string | null) =>
    ok(
      await ctx.req(`${WS}/members/${marcus.userId}/module-access/${moduleId}`, {
        method: "PUT",
        cookie: ada,
        json: { level },
      }),
    );
  const makeItem = async (body: Record<string, unknown>) =>
    (await ok(await as(ada).send("POST", "/items", body), 201)) as { id: string };

  let mill: string;
  let flour: string;
  let pastry: string;
  let tart: string;
  let film: string;
  let pastryRecipe: string;
  let tartRecipe: string;
  let flourSpec: string;

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
          json: { name: "t", scope: "write" },
        })
      ).json()
    ).token;

    mill = (await ok(await as(ada).send("POST", "/suppliers", { name: "Miller & Sons", code: "MILL" }), 201))
      .id;
    flour = (
      await makeItem({
        code: "FLR",
        name: "Flour T55",
        type: "ingredient",
        unit: "kg",
        allergens: ["cereals_gluten"],
        shelfLifeDays: 270,
      })
    ).id;
    pastry = (await makeItem({ code: "PST", name: "Sweet pastry", type: "wip", unit: "kg" })).id;
    tart = (
      await makeItem({
        code: "TART",
        name: "Bakewell tart",
        type: "finished",
        unit: "each",
        unitWeightG: 400,
        allergens: ["cereals_gluten"],
        shelfLifeDays: 10,
      })
    ).id;
    film = (await makeItem({ code: "FILM", name: "Lid film", type: "packaging", unit: "each" })).id;

    pastryRecipe = (
      await ok(
        await as(ada).send("POST", "/recipes", {
          code: "R-PST",
          name: "Sweet pastry",
          outputItemId: pastry,
          draft: { yieldQuantity: 1, yieldUnit: "kg", lines: [{ itemId: flour, quantity: 600, unit: "g" }] },
        }),
        201,
      )
    ).id;
    await ok(await as(ada).send("POST", `/recipes/${pastryRecipe}/draft/approve`));
    tartRecipe = (
      await ok(
        await as(ada).send("POST", "/recipes", {
          code: "R-TART",
          name: "Bakewell tart",
          outputItemId: tart,
          draft: {
            yieldQuantity: 10,
            yieldUnit: "each",
            lines: [{ itemId: pastry, quantity: 2, unit: "kg" }],
          },
        }),
        201,
      )
    ).id;
    await ok(await as(ada).send("POST", `/recipes/${tartRecipe}/draft/approve`));
  });

  afterAll(() => ctx.handle.close());

  it("is opt-in: members need a grant, and Items to be readable", async () => {
    expect((await as(marcus.cookie).get("/specifications")).status).toBe(403);
    await grant("specifications", "write");
    // Without Items the module resolves to none.
    await grant("items", "none");
    expect((await as(marcus.cookie).get("/specifications")).status).toBe(403);
    await grant("items", "read");
    expect((await as(marcus.cookie).get("/specifications")).status).toBe(403);
    await grant("food_items", "read");
    await ok(await as(marcus.cookie).get("/specifications"));
  });

  it("creates a supplier's ingredient specification with a draft", async () => {
    const created = await ok(
      await as(ada).send("POST", "/specifications", {
        code: "SPEC-FLR-MILL",
        title: "Flour T55 (Miller & Sons)",
        itemId: flour,
        supplierId: mill,
        draft: flourDraft(),
      }),
      201,
    );
    flourSpec = created.id;
    expect(created).toMatchObject({
      kind: "ingredient",
      party: "supplier",
      supplier: { id: mill, name: "Miller & Sons" },
      approvedVersion: null,
      draftVersion: { versionNumber: 1, status: "draft", shelfLifeDays: 270 },
      draftBlockers: [],
    });
    expect(created.draftVersion.parameters.map((p: { name: string }) => p.name)).toEqual([
      "Moisture",
      "Salmonella",
    ]);
    // Everything is new against no approved version.
    expect(created.draftChanges.fields.map((f: { field: string }) => f.field)).toContain("allergens");
    expect(created.draftChanges.parameters).toHaveLength(2);
    // The code is unique, case-insensitively.
    await fails(
      await as(ada).send("POST", "/specifications", { code: "spec-flr-mill", title: "Dup", itemId: flour }),
      409,
      "code_taken",
    );
  });

  it("checks who a specification is agreed with against the item", async () => {
    await fails(
      await as(ada).send("POST", "/specifications", {
        code: "X1",
        title: "x",
        itemId: tart,
        supplierId: mill,
      }),
      400,
    );
    await fails(
      await as(ada).send("POST", "/specifications", {
        code: "X2",
        title: "x",
        itemId: flour,
        customerName: "Shop",
      }),
      400,
    );
    await fails(
      await as(ada).send("POST", "/specifications", {
        code: "X3",
        title: "x",
        itemId: flour,
        supplierId: mill,
        customerName: "Shop",
      }),
      400,
    );
  });

  it("validates draft content", async () => {
    const bad = async (over: Record<string, unknown>) =>
      fails(await as(ada).send("PUT", `/specifications/${flourSpec}/draft`, flourDraft(over)), 400);
    await bad({ mayContain: ["cereals_gluten"] });
    await bad({ agreedOn: null });
    await bad({ minimumLifeOnReceiptDays: 300 });
    await bad({ parameters: [{ category: "chemical", name: "Moisture", min: 16, max: 15 }] });
    await bad({ parameters: [{ category: "chemical", name: "Ash" }] });
    await bad({
      parameters: [
        { category: "chemical", name: "Moisture", max: 15 },
        { category: "chemical", name: "moisture", max: 14 },
      ],
    });
  });

  it("says why a draft can't be approved and refuses until it can", async () => {
    const saved = await ok(
      await as(ada).send(
        "PUT",
        `/specifications/${flourSpec}/draft`,
        flourDraft({
          reviewDueOn: null,
          agreedBy: null,
          agreedOn: null,
          shelfLifeDays: null,
          minimumLifeOnReceiptDays: null,
        }),
      ),
    );
    expect(saved.draftBlockers).toEqual([
      "Set the shelf life",
      "Set a review date",
      "Record the supplier's agreement (who and when)",
    ]);
    const body = await fails(
      await as(ada).send("POST", `/specifications/${flourSpec}/draft/approve`),
      409,
      "not_ready",
    );
    expect(JSON.stringify(body)).toContain("Set a review date");
    await fails(
      await as(ada)
        .send("PUT", `/specifications/${flourSpec}/draft`, flourDraft({ reviewDueOn: "2020-01-01" }))
        .then(async (res) => {
          expect(res.status).toBe(200);
          return as(ada).send("POST", `/specifications/${flourSpec}/draft/approve`);
        }),
      409,
      "not_ready",
    );
  });

  it("approves with four eyes, by a person with manage, never a token", async () => {
    await ok(await as(ada).send("PUT", `/specifications/${flourSpec}/draft`, flourDraft()));
    // Write access isn't enough to approve.
    await fails(await as(marcus.cookie).send("POST", `/specifications/${flourSpec}/draft/approve`), 403);
    await grant("specifications", "manage");
    // Ada made the last edit and someone else can approve now.
    await fails(await as(ada).send("POST", `/specifications/${flourSpec}/draft/approve`), 403, "four_eyes");
    expect((await viaToken("POST", `/specifications/${flourSpec}/draft/approve`)).status).toBe(403);
    const approved = await ok(
      await as(marcus.cookie).send("POST", `/specifications/${flourSpec}/draft/approve`),
    );
    expect(approved).toMatchObject({
      approvedVersion: { versionNumber: 1, status: "approved", agreedBy: "J. Miller, Technical Manager" },
      draftVersion: null,
      reviewState: "ok",
      discrepancies: [],
    });
    expect(approved.approvedVersion.approvedByName).toBeTruthy();
  });

  it("drafts a revision, shows what changes, what it affects and where the item disagrees", async () => {
    // Tokens may prepare drafts.
    const revised = await ok(
      await viaToken(
        "PUT",
        `/specifications/${flourSpec}/draft`,
        flourDraft({
          mayContain: ["sesame"],
          shelfLifeDays: 240,
          minimumLifeOnReceiptDays: 90,
          parameters: [
            { category: "chemical", name: "Moisture", unit: "%", max: 15, method: "ISO 712" },
            { category: "physical", name: "Ash", unit: "%", min: 0.5, max: 0.6 },
          ],
          changeNote: "Supplier now mills sesame on the same line",
        }),
      ),
    );
    expect(revised.draftVersion.versionNumber).toBe(2);
    expect(revised.draftChanges).toMatchObject({
      addedAllergens: ["sesame"],
      removedAllergens: [],
      impacting: true,
    });
    expect(revised.draftChanges.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ change: "changed", name: "Moisture", from: "≤ 15.5 %", to: "≤ 15 %" }),
        expect.objectContaining({ change: "added", name: "Ash" }),
        expect.objectContaining({ change: "removed", name: "Salmonella" }),
      ]),
    );
    // Once approved, the item would understate sesame and outlast the specification.
    expect(revised.draftDiscrepancies.map((d: { kind: string }) => d.kind)).toEqual([
      "may_contain_undeclared",
      "shelf_life_longer",
    ]);

    const batch = await ok(
      await as(ada).send("POST", "/production/batches", {
        recipeId: tartRecipe,
        plannedOn: "2099-02-01",
        batches: 1,
      }),
      201,
    );
    const impact = await ok(await as(ada).get(`/specifications/${flourSpec}/impact`));
    expect(
      impact.recipes.map((r: { code: string; relation: string; depth: number }) => [
        r.code,
        r.relation,
        r.depth,
      ]),
    ).toEqual([
      ["R-PST", "ingredient", 1],
      ["R-TART", "indirect", 2],
    ]);
    expect(impact.batches.map((b: { id: string }) => b.id)).toEqual([batch.id]);
    expect(impact.labels).toEqual([]);
    expect(impact.hidden).toEqual([]);
    expect(impact.depthLimited).toBe(false);
    expect(impact.changes.addedAllergens).toEqual(["sesame"]);

    // A reader without Recipes or Production is told those parts are hidden, not that nothing is affected.
    const limited = await ok(await as(marcus.cookie).get(`/specifications/${flourSpec}/impact`));
    expect(limited.recipes).toBeNull();
    expect(limited.batches).toBeNull();
    expect(limited.hidden).toEqual(["recipes", "labels", "production"]);
  });

  it("supersedes the approved version and keeps the history comparable", async () => {
    // The token acted as Ada, so the revision is hers: someone else approves it.
    await fails(await as(ada).send("POST", `/specifications/${flourSpec}/draft/approve`), 403, "four_eyes");
    const approved = await ok(
      await as(marcus.cookie).send("POST", `/specifications/${flourSpec}/draft/approve`),
    );
    expect(approved.approvedVersion.versionNumber).toBe(2);
    expect(
      approved.versions.map((v: { versionNumber: number; status: string }) => [v.versionNumber, v.status]),
    ).toEqual([
      [2, "approved"],
      [1, "superseded"],
    ]);
    expect(
      approved.discrepancies.map((d: { kind: string; severity: string }) => [d.kind, d.severity]),
    ).toEqual([
      ["may_contain_undeclared", "serious"],
      ["shelf_life_longer", "serious"],
    ]);
    const v1 = approved.versions.find((v: { versionNumber: number }) => v.versionNumber === 1);
    const v2 = approved.versions.find((v: { versionNumber: number }) => v.versionNumber === 2);
    const old = await ok(await as(ada).get(`/specifications/${flourSpec}/versions/${v1.id}`));
    expect(old).toMatchObject({ status: "superseded", shelfLifeDays: 270, previousVersionNumber: null });
    const latest = await ok(await as(ada).get(`/specifications/${flourSpec}/versions/${v2.id}`));
    expect(latest.previousVersionNumber).toBe(1);
    expect(latest.changes.addedAllergens).toEqual(["sesame"]);

    // Fixing the item clears the discrepancies.
    await ok(await as(ada).send("PATCH", `/items/${flour}`, { mayContain: ["sesame"], shelfLifeDays: 240 }));
    const fixed = await ok(await as(ada).get(`/specifications/${flourSpec}`));
    expect(fixed.discrepancies).toEqual([]);
  });

  it("lists by kind, supplier, item and review state", async () => {
    await ok(
      await as(ada).send("POST", "/specifications", {
        code: "SPEC-TART",
        title: "Bakewell tart",
        itemId: tart,
        customerName: "Corner Shop Ltd",
        draft: {
          storage: "ambient",
          shelfLifeDays: 10,
          allergens: ["cereals_gluten"],
          reviewDueOn: "2099-01-01",
        },
      }),
      201,
    );
    await ok(
      await as(ada).send("POST", "/specifications", {
        code: "SPEC-FILM",
        title: "Lid film",
        itemId: film,
        draft: { packagingDetails: "PET/PE 40 µm, EU 10/2011 compliant", reviewDueOn: "2099-01-01" },
      }),
      201,
    );
    const all = await ok(await as(ada).get("/specifications"));
    expect(all.specifications.map((s: { code: string }) => s.code)).toEqual([
      "SPEC-FILM",
      "SPEC-FLR-MILL",
      "SPEC-TART",
    ]);
    const tartRow = all.specifications.find((s: { code: string }) => s.code === "SPEC-TART");
    expect(tartRow).toMatchObject({
      kind: "product",
      party: "customer",
      approvedVersion: null,
      reviewState: "none",
    });
    expect(tartRow.draftVersion.versionNumber).toBe(1);

    const codes = async (query: string) =>
      (await ok(await as(ada).get(`/specifications?${query}`))).specifications.map(
        (s: { code: string }) => s.code,
      );
    expect(await codes("kind=packaging")).toEqual(["SPEC-FILM"]);
    expect(await codes(`supplierId=${mill}`)).toEqual(["SPEC-FLR-MILL"]);
    expect(await codes(`itemId=${tart}`)).toEqual(["SPEC-TART"]);
    expect(await codes("q=corner")).toEqual(["SPEC-TART"]);
    // Needs attention: not yet approved, or a review falling due.
    expect(await codes("review=attention")).toEqual(["SPEC-FILM", "SPEC-TART"]);
    expect(await codes("review=overdue")).toEqual([]);
  });

  it("keeps approved specifications: archive, never delete; archived ones can't be edited", async () => {
    await fails(await as(ada).send("DELETE", `/specifications/${flourSpec}`), 409, "specification_approved");
    // The party is fixed once approved.
    await fails(
      await as(ada).send("PATCH", `/specifications/${flourSpec}`, { supplierId: null }),
      409,
      "party_fixed",
    );
    await ok(await as(ada).send("PATCH", `/specifications/${flourSpec}`, { status: "archived" }));
    await fails(
      await as(ada).send("PUT", `/specifications/${flourSpec}/draft`, flourDraft()),
      409,
      "specification_archived",
    );
    expect(
      (await ok(await as(ada).get("/specifications"))).specifications.map((s: { code: string }) => s.code),
    ).not.toContain("SPEC-FLR-MILL");
    // A never-approved one can be deleted, with its draft.
    const film = (await ok(await as(ada).get("/specifications?kind=packaging"))).specifications[0];
    expect((await as(ada).send("DELETE", `/specifications/${film.id}`)).status).toBe(204);
    expect((await as(ada).get(`/specifications/${film.id}`)).status).toBe(404);
  });

  it("puts metadata, never content, in the sync log", async () => {
    const page = await (await ctx.req(`${WS}/sync?after=0&limit=1000`, { cookie: ada })).json();
    const versions = page.changes.filter(
      (c: { entity: string; action: string }) =>
        c.entity === "specification_version" && c.action === "upsert",
    );
    expect(versions.length).toBeGreaterThan(0);
    for (const change of versions) {
      expect(change.data).not.toHaveProperty("provenance");
      expect(change.data).not.toHaveProperty("allergens");
      expect(change.data).not.toHaveProperty("agreedBy");
      expect(change.data).toHaveProperty("versionNumber");
    }
    // Readers without the module never see its entities.
    await grant("specifications", null);
    const theirs = await (await ctx.req(`${WS}/sync?after=0&limit=1000`, { cookie: marcus.cookie })).json();
    expect(theirs.changes.some((c: { entity: string }) => c.entity.startsWith("specification"))).toBe(false);
  });
});
