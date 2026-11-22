import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";

describe("supplier controls", () => {
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
    if (code) expect(body.error?.code).toBe(code);
    return body;
  };
  const kinds = (issues: { kind: string }[]) => issues.map((i) => i.kind);

  let mill: string;
  let pest: string;
  let flour: string;
  let sugar: string;
  const today = new Date().toISOString().slice(0, 10);
  const nextYear = `${Number(today.slice(0, 4)) + 1}${today.slice(4)}`;
  const inTenDays = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    const { members } = await (await ctx.req(`${WS}/members`, { cookie: ada })).json();
    const m = members.find((x: { email: string }) => x.email === "marcus@knotworking.dev");
    marcus = { userId: m.userId, cookie: (await signIn(ctx, m.email)).cookie };
    await ctx.req(`${WS}/members/${marcus.userId}/module-access/items`, {
      method: "PUT",
      cookie: ada,
      json: { level: "write" },
    });
    token = (
      await (
        await ctx.req("/v1/me/api-tokens", {
          method: "POST",
          cookie: ada,
          json: { name: "t", scope: "write" },
        })
      ).json()
    ).token;
    mill = (
      await ok(
        await as(ada).send("POST", "/suppliers", {
          name: "Miller & Sons",
          certification: "BRCGS AA",
          certificateExpiresOn: inTenDays,
        }),
        201,
      )
    ).id;
    pest = (
      await ok(
        await as(ada).send("POST", "/suppliers", {
          name: "BugsAway",
          category: "service",
          serviceType: "Pest control",
        }),
        201,
      )
    ).id;
    flour = (
      await ok(
        await as(ada).send("POST", "/items", {
          code: "FLR",
          name: "Flour",
          type: "ingredient",
          unit: "kg",
          suppliers: [{ supplierId: mill }],
        }),
        201,
      )
    ).id;
    sugar = (
      await ok(
        await as(ada).send("POST", "/items", {
          code: "SUG",
          name: "Sugar",
          type: "ingredient",
          unit: "kg",
          suppliers: [{ supplierId: mill }],
        }),
        201,
      )
    ).id;
  });

  afterAll(() => ctx.handle.close());

  it("keeps a supplier's category and filters by it", async () => {
    const services = await ok(await as(ada).get("/suppliers?category=service"));
    expect(services.suppliers.map((s: { name: string }) => s.name)).toEqual(["BugsAway"]);
    expect(services.suppliers[0]).toMatchObject({ category: "service", serviceType: "Pest control" });
  });

  it("flags suppliers without assessments", async () => {
    const { suppliers } = await ok(await as(ada).get("/suppliers/compliance"));
    const millRow = suppliers.find((s: { supplierId: string }) => s.supplierId === mill);
    expect(millRow).toMatchObject({ riskLevel: null, actionCount: 1 });
    expect(kinds(millRow.issues)).toEqual(["no_assessment"]);
    expect(suppliers.find((s: { supplierId: string }) => s.supplierId === pest).issues[0].message).toContain(
      "service provider",
    );
  });

  it("records risk assessments per item: a person with manage, superseding the current one", async () => {
    const body = {
      itemId: flour,
      riskLevel: "high",
      hazards: ["microbiological", "allergen"],
      rationale: "Raw flour: STEC and Salmonella risk; milled alongside sesame",
      controls: ["certificate", "questionnaire", "specification", "coa_each_delivery"],
      reviewDueOn: nextYear,
    };
    expect((await viaToken("POST", `/suppliers/${mill}/risk-assessments`, body)).status).toBe(403);
    expect((await as(marcus.cookie).send("POST", `/suppliers/${mill}/risk-assessments`, body)).status).toBe(
      403,
    );
    await fails(
      await as(ada).send("POST", `/suppliers/${mill}/risk-assessments`, { ...body, reviewDueOn: today }),
      400,
    );
    await fails(
      await as(ada).send("POST", `/suppliers/${pest}/risk-assessments`, { ...body, itemId: flour }),
      400,
    );
    const first = await ok(await as(ada).send("POST", `/suppliers/${mill}/risk-assessments`, body), 201);
    expect(first.riskLevel).toBe("high");
    const flourAssessment = first.assessments.find((a: { itemCode: string }) => a.itemCode === "FLR");
    expect(
      flourAssessment.controlStates.map((c: { control: string; state: string }) => [c.control, c.state]),
    ).toEqual([
      ["certificate", "expiring"],
      ["questionnaire", "missing"],
      ["specification", "missing"],
      ["coa_each_delivery", "at_goods_in"],
    ]);
    // Sugar is bought from the mill and not assessed.
    expect(kinds(first.issues)).toEqual(
      expect.arrayContaining(["item_not_assessed", "control_missing", "control_expiring"]),
    );
    expect(first.issues.find((i: { kind: string }) => i.kind === "item_not_assessed").message).toContain(
      "SUG",
    );

    const second = await ok(
      await as(ada).send("POST", `/suppliers/${mill}/risk-assessments`, {
        ...body,
        riskLevel: "medium",
        controls: ["certificate"],
        rationale: "Heat-treated flour from now on",
      }),
      201,
    );
    expect(second.riskLevel).toBe("medium");
    expect(second.assessments).toHaveLength(1);
    expect(second.history).toHaveLength(2);
    expect(second.history.filter((h: { supersededAt: string | null }) => h.supersededAt)).toHaveLength(1);
    // Assessing the supplier as a whole covers every item.
    const whole = await ok(
      await as(ada).send("POST", `/suppliers/${mill}/risk-assessments`, {
        riskLevel: "low",
        rationale: "Ambient dry goods",
        controls: [],
        reviewDueOn: nextYear,
      }),
      201,
    );
    expect(kinds(whole.issues)).not.toContain("item_not_assessed");
    void sugar;
  });

  it("tracks questionnaires from sent to accepted, which then meets the control", async () => {
    const q = await ok(
      await viaToken("POST", `/suppliers/${pest}/questionnaires`, { title: "Annual SAQ", sentOn: today }),
      201,
    );
    expect(q.status).toBe("sent");
    await fails(
      await as(ada).send("POST", `/suppliers/${pest}/questionnaires/${q.id}/review`, {
        decision: "accepted",
        validUntil: nextYear,
      }),
      409,
      "not_received",
    );
    await ok(
      await viaToken("POST", `/suppliers/${pest}/questionnaires/${q.id}/receive`, { receivedOn: today }),
    );
    // Accepting needs a person with manage and a validity date; rejecting needs a reason.
    expect(
      (
        await viaToken("POST", `/suppliers/${pest}/questionnaires/${q.id}/review`, {
          decision: "accepted",
          validUntil: nextYear,
        })
      ).status,
    ).toBe(403);
    await fails(
      await as(ada).send("POST", `/suppliers/${pest}/questionnaires/${q.id}/review`, {
        decision: "accepted",
      }),
      400,
    );
    await fails(
      await as(ada).send("POST", `/suppliers/${pest}/questionnaires/${q.id}/review`, {
        decision: "rejected",
      }),
      400,
    );
    const accepted = await ok(
      await as(ada).send("POST", `/suppliers/${pest}/questionnaires/${q.id}/review`, {
        decision: "accepted",
        validUntil: nextYear,
      }),
    );
    expect(accepted).toMatchObject({ status: "accepted", validUntil: nextYear });

    const controls = await ok(
      await as(ada).send("POST", `/suppliers/${pest}/risk-assessments`, {
        riskLevel: "medium",
        hazards: ["chemical"],
        rationale: "Baits used near production",
        controls: ["questionnaire", "audit"],
        reviewDueOn: nextYear,
      }),
      201,
    );
    expect(controls.assessments[0].controlStates.map((c: { state: string }) => c.state)).toEqual([
      "met",
      "not_tracked",
    ]);
    expect(controls.actionCount).toBe(0);
    expect(controls.questionnaires[0].reviewedByName).toBeTruthy();
    await fails(
      await as(ada).send("POST", `/suppliers/${pest}/risk-assessments`, {
        riskLevel: "low",
        rationale: "x",
        controls: ["specification"],
        reviewDueOn: nextYear,
      }),
      400,
    );
  });

  it("syncs assessments and questionnaires to Items readers only", async () => {
    const page = await (await ctx.req(`${WS}/sync?after=0&limit=1000`, { cookie: ada })).json();
    expect(page.changes.some((c: { entity: string }) => c.entity === "supplier_risk_assessment")).toBe(true);
    expect(page.changes.some((c: { entity: string }) => c.entity === "supplier_questionnaire")).toBe(true);
    await ctx.req(`${WS}/members/${marcus.userId}/module-access/items`, {
      method: "PUT",
      cookie: ada,
      json: { level: null },
    });
    const theirs = await (await ctx.req(`${WS}/sync?after=0&limit=1000`, { cookie: marcus.cookie })).json();
    expect(theirs.changes.some((c: { entity: string }) => c.entity.startsWith("supplier_"))).toBe(false);
  });
});
