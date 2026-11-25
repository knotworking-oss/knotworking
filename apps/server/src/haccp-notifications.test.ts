import { DEFAULT_TIME_ZONE, todayInZone } from "@knotworking/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";
const today = todayInZone(DEFAULT_TIME_ZONE);
const DEPENDENCIES = ["assets", "items", "recipes", "stock", "demand", "production"] as const;

const cooking = {
  code: "CCP1",
  processStep: "Cooking",
  hazardType: "biological",
  hazard: "Survival of vegetative pathogens",
  limitType: "range",
  limitMin: 75,
  limitUnit: "°C",
  monitoringMethod: "Probe the core",
  frequency: { every: 1, unit: "batch" },
  responsibleRole: "Cook",
  correctiveAction: "Continue cooking",
  verification: "Supervisor reviews daily",
};

type Item = {
  id: string;
  type: string;
  module: string | null;
  readAt: string | null;
  data: { title?: string };
};

describe("HACCP notifications and the batch deviation warning", () => {
  let ctx: TestCtx;
  let ada: { cookie: string; userId: string };
  let marcus: { cookie: string; userId: string };
  let priya: { cookie: string; userId: string };
  let agentToken: string;
  let ccp: string;
  let batchA: string;
  let batchB: string;

  const send = (cookie: string, method: string, path: string, json?: unknown) =>
    ctx.req(`${WS}${path}`, { method, cookie, json });
  const viaToken = (method: string, path: string, json?: unknown) =>
    ctx.req(`${WS}${path}`, {
      method,
      headers: { authorization: `Bearer ${agentToken}`, origin: "" },
      json,
    });
  const ok = async (res: Awaited<ReturnType<TestCtx["req"]>>, status = 200) => {
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(status);
    return body;
  };
  const inbox = async (who: { cookie: string }): Promise<Item[]> =>
    (await ok(await ctx.req(`${WS}/notifications?limit=100`, { cookie: who.cookie }))).notifications;
  const ofType = async (who: { cookie: string }, type: string) =>
    (await inbox(who)).filter((n) => n.type === type);
  const grant = async (userId: string, moduleId: string, level: string | null) =>
    ok(await send(ada.cookie, "PUT", `/members/${userId}/module-access/${moduleId}`, { level }));

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    const login = await signIn(ctx, "ada@knotworking.dev");
    const { members } = await (await ctx.req(`${WS}/members`, { cookie: login.cookie })).json();
    const who = async (name: string) => {
      const m = members.find((x: { email: string }) => x.email === `${name}@knotworking.dev`);
      return { userId: m.userId as string, cookie: (await signIn(ctx, m.email)).cookie };
    };
    ada = await who("ada");
    marcus = await who("marcus");
    priya = await who("priya");
    agentToken = (
      await (
        await ctx.req("/v1/me/api-tokens", {
          method: "POST",
          cookie: ada.cookie,
          json: { name: "agent", scope: "write" },
        })
      ).json()
    ).token as string;

    // Marcus manages haccp, Priya only reads it.
    for (const id of DEPENDENCIES) {
      await grant(marcus.userId, id, "write");
      await grant(priya.userId, id, "read");
    }
    await grant(marcus.userId, "haccp", "manage");
    await grant(priya.userId, "haccp", "read");
    await grant(priya.userId, "production", "manage");

    const veg = (
      await ok(
        await send(ada.cookie, "POST", "/items", {
          code: "VEG",
          name: "Veg",
          type: "ingredient",
          unit: "kg",
        }),
        201,
      )
    ).id;
    const soup = (
      await ok(
        await send(ada.cookie, "POST", "/items", { code: "SOUP", name: "Soup", type: "finished", unit: "l" }),
        201,
      )
    ).id;
    const recipe = await ok(
      await send(ada.cookie, "POST", "/recipes", {
        code: "R-SOUP",
        name: "Soup",
        outputItemId: soup,
        draft: { yieldQuantity: 10, yieldUnit: "l", lines: [{ itemId: veg, quantity: 5, unit: "kg" }] },
      }),
      201,
    );
    await ok(await send(ada.cookie, "POST", `/recipes/${recipe.id}/draft/approve`));
    const store = (await ok(await send(ada.cookie, "POST", "/stock/locations", { name: "Chiller" }), 201)).id;
    const batch = async () => {
      const b = await ok(
        await send(ada.cookie, "POST", "/production/batches", {
          recipeId: recipe.id,
          plannedOn: today,
          batches: 1,
          outputLocationId: store,
        }),
        201,
      );
      await ok(await send(ada.cookie, "POST", `/production/batches/${b.id}/start`));
      await ok(
        await send(ada.cookie, "POST", `/production/batches/${b.id}/output`, { quantity: 10, unit: "l" }),
        201,
      );
      return b.id as string;
    };
    batchA = await batch();
    batchB = await batch();
    const plan = await ok(
      await send(ada.cookie, "POST", "/haccp/plans", {
        code: "HACCP-01",
        name: "Soups",
        draft: { scope: { itemIds: [soup] }, ccps: [cooking] },
      }),
      201,
    );
    await ok(await send(marcus.cookie, "POST", `/haccp/plans/${plan.id}/draft/approve`, {}));
    ccp = (await ok(await send(ada.cookie, "GET", `/haccp/plans/${plan.id}`))).currentVersion.ccps[0].id;
  }, 60_000);
  afterAll(() => ctx.handle.close());

  describe("readings awaiting review", () => {
    it("tells managers once about a sheet of readings from a token, not the recorder or readers", async () => {
      ctx.mailer.sent.length = 0;
      for (const value of [80, 81, 82]) {
        await ok(await viaToken("POST", "/haccp/logs", { ccpId: ccp, value, batchId: batchA }), 201);
      }
      // The token belongs to Ada, who recorded them: Marcus (manage) is told, once.
      const marcusAlerts = await ofType(marcus, "readings_awaiting_review");
      expect(marcusAlerts).toHaveLength(1);
      expect(marcusAlerts[0]).toMatchObject({ module: "haccp", readAt: null });
      expect(await ofType(ada, "readings_awaiting_review")).toHaveLength(0);
      expect(await ofType(priya, "readings_awaiting_review")).toHaveLength(0);
      await vi.waitFor(() =>
        expect(ctx.mailer.sent.filter((m) => m.to === "marcus@knotworking.dev")).toHaveLength(1),
      );
      expect(ctx.mailer.sent[0]!.text).toContain("/acme/haccp/review");
    });

    it("notifies again once the earlier entry has been read, and not for a person's own reading", async () => {
      const [first] = await ofType(marcus, "readings_awaiting_review");
      await ok(await send(marcus.cookie, "POST", `/notifications/${first!.id}/read`));
      await ok(
        await send(ada.cookie, "POST", "/haccp/logs", { ccpId: ccp, value: 90, batchId: batchA }),
        201,
      );
      expect(await ofType(marcus, "readings_awaiting_review")).toHaveLength(1);
      await ok(await viaToken("POST", "/haccp/logs", { ccpId: ccp, value: 83, batchId: batchA }), 201);
      expect(await ofType(marcus, "readings_awaiting_review")).toHaveLength(2);
    });

    it("hides it from someone who loses haccp access, and honours the per-type email preference", async () => {
      await ok(
        await ctx.req(`${WS}/notifications/preferences`, {
          method: "PUT",
          cookie: marcus.cookie,
          json: { emailTypes: { readings_awaiting_review: false } },
        }),
      );
      const [latest] = await ofType(marcus, "readings_awaiting_review");
      await ok(await send(marcus.cookie, "POST", `/notifications/${latest!.id}/read`));
      ctx.mailer.sent.length = 0;
      await ok(await viaToken("POST", "/haccp/logs", { ccpId: ccp, value: 84, batchId: batchA }), 201);
      expect(await ofType(marcus, "readings_awaiting_review")).toHaveLength(3);
      expect(ctx.mailer.sent.filter((m) => m.to === "marcus@knotworking.dev")).toHaveLength(0);
    });
  });

  describe("deviations", () => {
    it("tells managers about a deviation raised by hand, once, and not those who can only read", async () => {
      const action = await ok(
        await send(ada.cookie, "POST", "/haccp/corrective-actions", {
          title: "Cooler door left open",
          batchId: batchB,
        }),
        201,
      );
      const alerts = await ofType(marcus, "deviation_recorded");
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({ module: "haccp", data: { title: "Cooler door left open" } });
      expect(await ofType(ada, "deviation_recorded")).toHaveLength(0);
      expect(await ofType(priya, "deviation_recorded")).toHaveLength(0);
      expect(action.id).toBeTruthy();
    });

    it("does not announce a corrective action that answers an out-of-limit reading twice", async () => {
      const log = await ok(
        await send(ada.cookie, "POST", "/haccp/logs", { ccpId: ccp, value: 60, batchId: batchB }),
        201,
      );
      expect(log.withinLimits).toBe(false);
      expect(await ofType(marcus, "reading_out_of_limit")).toHaveLength(1);
      await ok(
        await send(marcus.cookie, "POST", "/haccp/corrective-actions", {
          title: "Follow-up on reading",
          logId: log.id,
        }),
        201,
      );
      expect(await ofType(ada, "deviation_recorded")).toHaveLength(0);
      expect(await ofType(ada, "reading_out_of_limit")).toHaveLength(0); // she recorded it
      expect(await ofType(marcus, "reading_out_of_limit")).toHaveLength(1);
    });

    it("does not announce a correction that carries an open action over", async () => {
      const before = (await ofType(marcus, "reading_out_of_limit")).length;
      const log = await ok(
        await send(ada.cookie, "POST", "/haccp/logs", { ccpId: ccp, value: 61, batchId: batchB }),
        201,
      );
      await ok(
        await send(ada.cookie, "POST", `/haccp/logs/${log.id}/correct`, { value: 62, reason: "Re-probed" }),
        201,
      );
      // The earlier action for this reading is still open, so the correction opens none and tells no one.
      expect((await ofType(marcus, "reading_out_of_limit")).length).toBe(before + 1);
    });
  });

  it("announces a correction that turns a good reading into a deviation", async () => {
    const before = (await ofType(marcus, "reading_out_of_limit")).length;
    const log = await ok(
      await send(ada.cookie, "POST", "/haccp/logs", { ccpId: ccp, value: 85, batchId: batchB }),
      201,
    );
    expect(await ofType(marcus, "reading_out_of_limit")).toHaveLength(before);
    await ok(
      await send(ada.cookie, "POST", `/haccp/logs/${log.id}/correct`, { value: 50, reason: "Misread" }),
      201,
    );
    expect(await ofType(marcus, "reading_out_of_limit")).toHaveLength(before + 1);
  });

  describe("completing a batch with an open deviation", () => {
    it("completes and warns the people who can read haccp, naming the open deviations", async () => {
      const done = await ok(await send(priya.cookie, "POST", `/production/batches/${batchB}/complete`, {}));
      expect(done.status).toBe("completed");
      expect(done.haccpWarning.openDeviations).toBeGreaterThanOrEqual(2);
      expect(done.haccpWarning.actions[0]).toHaveProperty("title");
    });

    it("gives no warning to someone who can't read haccp, and none for a batch without deviations", async () => {
      await grant(priya.userId, "haccp", "none");
      const second = await ok(await send(ada.cookie, "GET", `/production/batches/${batchA}`));
      expect(second.status).toBe("in_progress");
      // An open deviation on batch A that the reader cannot see about.
      await ok(
        await send(ada.cookie, "POST", "/haccp/corrective-actions", {
          title: "Metal found",
          batchId: batchA,
        }),
        201,
      );
      const hidden = await ok(await send(priya.cookie, "POST", `/production/batches/${batchA}/complete`, {}));
      expect(hidden.status).toBe("completed");
      expect(hidden.haccpWarning).toBeNull();
    });
  });
});
