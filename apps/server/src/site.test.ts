import { addDays, DEFAULT_TIME_ZONE, todayInZone } from "@knotworking/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addHaccpAsset, makeApp, signIn, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";
const DAY = 86_400_000;
const today = todayInZone(DEFAULT_TIME_ZONE);
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();
const dateAgo = (n: number) => daysAgo(n).slice(0, 10);
const dateAhead = (n: number) => addDays(todayInZone(DEFAULT_TIME_ZONE), n);
// Site needs only the asset register; HACCP (calibration instruments) is a soft dependency.
const DEPENDENCIES = ["assets"] as const;

describe("site programmes module", () => {
  let ctx: TestCtx;
  let ada: string;
  let marcus: { cookie: string; userId: string };
  let agentToken: string;
  const as = (cookie: string) => ({
    get: (path: string) => ctx.req(`${WS}${path}`, { cookie }),
    send: (method: string, path: string, json?: unknown) => ctx.req(`${WS}${path}`, { method, cookie, json }),
  });
  const viaToken = (token: string, method: string, path: string, json?: unknown) =>
    ctx.req(`${WS}${path}`, { method, headers: { authorization: `Bearer ${token}`, origin: "" }, json });
  const grant = (moduleId: string, level: string | null) =>
    ctx.req(`${WS}/members/${marcus.userId}/module-access/${moduleId}`, {
      method: "PUT",
      cookie: ada,
      json: { level },
    });
  const ok = async (res: Awaited<ReturnType<TestCtx["req"]>>, status = 200) => {
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(status);
    return body;
  };
  const error = async (res: Awaited<ReturnType<TestCtx["req"]>>, status: number) => {
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(status);
    return body.error.code as string;
  };
  const due = async (query = "include=all") =>
    (await ok(await as(ada).get(`/site/due?${query}`))) as {
      items: { programme: string; subjectId: string; state: string; title: string; dueOn: string | null }[];
      counts: Record<string, number>;
    };

  // Fixtures.
  let packing: string; // area
  let dispatch: string; // area
  let batchBefore: string;
  let batchAfter: string;

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    const { members } = await (await ctx.req(`${WS}/members`, { cookie: ada })).json();
    const m = members.find((x: { email: string }) => x.email === "marcus@knotworking.dev");
    marcus = { userId: m.userId, cookie: (await signIn(ctx, m.email)).cookie };
    agentToken = (
      await (
        await ctx.req("/v1/me/api-tokens", {
          method: "POST",
          cookie: ada,
          json: { name: "agent", scope: "write" },
        })
      ).json()
    ).token as string;

    const area = async (name: string) =>
      (await addHaccpAsset(as(ada).send, { kind: "area", name })).id as string;
    packing = await area("Packing hall");
    dispatch = await area("Dispatch");

    const veg = (
      await ok(
        await as(ada).send("POST", "/items", { code: "VEG", name: "Veg", type: "ingredient", unit: "kg" }),
        201,
      )
    ).id;
    const soup = (
      await ok(
        await as(ada).send("POST", "/items", { code: "SOUP", name: "Soup", type: "finished", unit: "l" }),
        201,
      )
    ).id;
    const recipe = await ok(
      await as(ada).send("POST", "/recipes", {
        code: "R-SOUP",
        name: "Soup",
        outputItemId: soup,
        draft: { yieldQuantity: 10, yieldUnit: "l", lines: [{ itemId: veg, quantity: 5, unit: "kg" }] },
      }),
      201,
    );
    await ok(await as(ada).send("POST", `/recipes/${recipe.id}/draft/approve`));
    const batch = async () =>
      (
        await ok(
          await as(ada).send("POST", "/production/batches", {
            recipeId: recipe.id,
            plannedOn: today,
            batches: 1,
          }),
          201,
        )
      ).id as string;
    batchBefore = await batch();
    batchAfter = await batch();
  }, 60_000);

  afterAll(async () => {
    await ctx.handle.close();
  });

  describe("access", () => {
    it("is opt-in and needs the asset register to be readable, not haccp", async () => {
      expect((await as(marcus.cookie).get("/site/due")).status).toBe(403);
      await grant("site", "write");
      expect((await as(marcus.cookie).get("/site/due")).status).toBe(403);
      for (const id of DEPENDENCIES) await grant(id, "read");
      expect((await as(marcus.cookie).get("/site/due")).status).toBe(200);
    });

    it("lists the areas of the asset register", async () => {
      const { areas } = await ok(await as(marcus.cookie).get("/site/areas"));
      expect(areas.map((a: { name: string }) => a.name)).toEqual(["Dispatch", "Packing hall"]);
    });

    it("is switched off with the module", async () => {
      const off = await makeApp({
        seed: true,
        activeModules: ["tasks", "docs", "items", "recipes", "stock", "demand", "production", "haccp"],
      });
      const cookie = (await signIn(off, "ada@knotworking.dev")).cookie;
      const res = await off.req(`${WS}/site/due`, { cookie });
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe("module_inactive");
      await off.handle.close();
    }, 60_000);

    it("lets a token read", async () => {
      expect((await viaToken(agentToken, "GET", "/site/due")).status).toBe(200);
    });
  });

  describe("pest control", () => {
    let bait: string;
    let efk: string;
    let visit: string;

    it("keeps a register of devices with unique codes", async () => {
      bait = (
        await ok(
          await as(ada).send("POST", "/site/pest/devices", {
            kind: "rodent_bait_station",
            code: "RB-01",
            location: "Dock door",
            areaId: dispatch,
          }),
          201,
        )
      ).id;
      efk = (
        await ok(
          await viaToken(agentToken, "POST", "/site/pest/devices", {
            kind: "insect_electric_fly_killer",
            code: "EFK-1",
            location: "Packing hall entrance",
          }),
          201,
        )
      ).id;
      expect(
        await error(
          await as(ada).send("POST", "/site/pest/devices", {
            kind: "rodent_trap",
            code: "rb-01",
            location: "x",
          }),
          409,
        ),
      ).toBe("code_taken");
      expect(
        await error(
          await as(ada).send("POST", "/site/pest/devices", {
            kind: "rodent_trap",
            code: "T-1",
            location: "x",
            areaId: bait,
          }),
          404,
        ),
      ).toBe("not_found");
    });

    it("says there is no visit yet in what's due", async () => {
      const d = await due();
      expect(d.items.find((i) => i.programme === "pest")).toMatchObject({
        state: "due",
        dueOn: null,
        reason: "no_visit_recorded",
      });
    });

    it("records a visit with findings; an agent may enter a service report", async () => {
      const body = {
        contractor: "Pestaway",
        technician: "J. Fox",
        visitedOn: dateAgo(40),
        summary: "Routine visit",
        recommendations: "Proof the dock door",
        nextVisitOn: dateAgo(5),
        findings: [
          { deviceId: bait, activity: "moderate", pest: "mice", count: 2, action: "Rebaited" },
          { deviceId: efk, activity: "none" },
          { location: "Goods-in corridor", activity: "low", pest: "flies" },
        ],
      };
      const created = await ok(await viaToken(agentToken, "POST", "/site/pest/visits", body), 201);
      expect(created).toMatchObject({ source: "api", highestActivity: "moderate", correctedByVisitId: null });
      expect(created.findings).toHaveLength(3);
      expect(created.findings[0].device).toMatchObject({ code: "RB-01" });
      visit = created.id;
      expect(
        await error(
          await as(ada).send("POST", "/site/pest/visits", {
            ...body,
            findings: [
              { deviceId: bait, activity: "none" },
              { deviceId: bait, activity: "none" },
            ],
          }),
          400,
        ),
      ).toBe("invalid_input");
      expect(
        await error(
          await as(ada).send("POST", "/site/pest/visits", { contractor: "X", visitedOn: dateAhead(3) }),
          400,
        ),
      ).toBe("invalid_input");
    });

    it("shows the latest activity per device and the next visit as overdue", async () => {
      const { devices } = await ok(await as(ada).get("/site/pest/devices"));
      expect(devices.find((d: { id: string }) => d.id === bait).lastFinding).toMatchObject({
        activity: "moderate",
        pest: "mice",
      });
      const d = await due();
      expect(d.items.find((i) => i.programme === "pest")).toMatchObject({
        state: "overdue",
        dueOn: dateAgo(5),
      });
      expect(d.counts.pestActivity).toBe(1);
    });

    it("corrects a visit with a new one that points at it; only a person, only once", async () => {
      const body = {
        reason: "Wrong date",
        contractor: "Pestaway",
        visitedOn: dateAgo(41),
        nextVisitOn: dateAhead(30),
        findings: [{ deviceId: bait, activity: "low", pest: "mice" }],
      };
      expect(
        await error(await viaToken(agentToken, "POST", `/site/pest/visits/${visit}/correct`, body), 403),
      ).toBe("token_not_allowed");
      const fixed = await ok(
        await as(marcus.cookie).send("POST", `/site/pest/visits/${visit}/correct`, body),
        201,
      );
      expect(fixed).toMatchObject({
        correctsVisitId: visit,
        correctionReason: "Wrong date",
        source: "manual",
      });
      expect(
        await error(await as(marcus.cookie).send("POST", `/site/pest/visits/${visit}/correct`, body), 409),
      ).toBe("already_corrected");
      const list = await ok(await as(ada).get("/site/pest/visits?includeCorrected=false"));
      expect(list.visits.map((v: { id: string }) => v.id)).toEqual([fixed.id]);
      const all = await ok(await as(ada).get("/site/pest/visits"));
      expect(all.visits.find((v: { id: string }) => v.id === visit).correctedByVisitId).toBe(fixed.id);
      // The corrected visit no longer counts: the next visit is the correction's.
      const d = await due();
      expect(d.items.find((i) => i.programme === "pest")).toMatchObject({
        state: "ok",
        dueOn: dateAhead(30),
      });
      expect((await as(ada).send("DELETE", `/site/pest/visits/${visit}`)).status).toBe(404);
    });

    it("keeps pest control on what's due, as needing attention, when the latest visit sets no next date", async () => {
      await ok(
        await as(ada).send("POST", "/site/pest/visits", {
          contractor: "Pestaway",
          visitedOn: dateAgo(1),
          findings: [{ deviceId: bait, activity: "none" }],
        }),
        201,
      );
      const item = (await due("include=due")).items.find((i) => i.programme === "pest");
      expect(item).toMatchObject({
        state: "due",
        dueOn: null,
        reason: "no_next_visit",
        note: "No next visit set",
      });
    });
  });

  describe("glass and brittle plastics", () => {
    let window: string;
    let lamp: string;

    it("registers items by area and checks the area", async () => {
      window = (
        await ok(
          await as(ada).send("POST", "/site/glass/items", {
            areaId: packing,
            kind: "glass",
            description: "East window",
            quantity: 2,
            checkFrequency: { every: 1, unit: "week" },
          }),
          201,
        )
      ).id;
      lamp = (
        await ok(
          await viaToken(agentToken, "POST", "/site/glass/items", {
            areaId: packing,
            kind: "brittle_plastic",
            description: "Light diffuser line 1",
          }),
          201,
        )
      ).id;
      expect(
        await error(
          await as(ada).send("POST", "/site/glass/items", {
            areaId: bait2(),
            kind: "glass",
            description: "x",
          }),
          404,
        ),
      ).toBe("not_found");
      const { items } = await ok(await as(ada).get(`/site/glass/items?areaId=${packing}`));
      expect(items).toHaveLength(2);
      expect(items.find((i: { id: string }) => i.id === lamp)).toMatchObject({
        checkFrequency: { every: 1, unit: "month" },
        lastCheck: null,
        due: { state: "due" },
      });
    });
    const bait2 = () => "0190a1a0-0000-7000-8000-0000000000aa";

    it("records a round of checks as a person; damaged items need a note", async () => {
      const body = {
        checks: [
          { itemId: window, condition: "intact" },
          { itemId: lamp, condition: "damaged", note: "Cracked corner" },
        ],
      };
      expect(await error(await viaToken(agentToken, "POST", "/site/glass/checks", body), 403)).toBe(
        "token_not_allowed",
      );
      expect(
        await error(
          await as(marcus.cookie).send("POST", "/site/glass/checks", {
            checks: [{ itemId: lamp, condition: "missing" }],
          }),
          400,
        ),
      ).toBe("invalid_input");
      const { checks } = await ok(await as(marcus.cookie).send("POST", "/site/glass/checks", body), 201);
      expect(checks).toHaveLength(2);
      const d = await due();
      expect(d.counts.glassProblems).toBe(1);
      const line = d.items.find((i) => i.programme === "glass");
      expect(line?.state).toMatch(/ok|soon/);
    });

    it("corrects a check with a new row", async () => {
      const { checks } = await ok(await as(ada).get(`/site/glass/checks?itemId=${lamp}`));
      const wrong = checks[0];
      expect(wrong.condition).toBe("damaged");
      const fixed = await ok(
        await as(marcus.cookie).send("POST", `/site/glass/checks/${wrong.id}/correct`, {
          reason: "Wrong lamp",
          condition: "intact",
        }),
        201,
      );
      expect(fixed).toMatchObject({ correctsCheckId: wrong.id, condition: "intact" });
      expect(
        await error(
          await as(marcus.cookie).send("POST", `/site/glass/checks/${wrong.id}/correct`, {
            reason: "again",
            condition: "intact",
          }),
          409,
        ),
      ).toBe("already_corrected");
      expect((await due()).counts.glassProblems).toBe(0);
    });

    it("holds an area from a breakage until a person with manage releases it", async () => {
      const breakage = await ok(
        await viaToken(agentToken, "POST", "/site/glass/breakages", {
          areaId: packing,
          itemId: lamp,
          description: "Diffuser fell onto line 1",
          quarantined: "Line 1 product from 09:00 to 09:40",
        }),
        201,
      );
      expect(breakage).toMatchObject({ status: "open", source: "api", cleanDown: null });
      expect((await due()).counts.openBreakages).toBe(1);
      expect(
        await error(
          await as(ada).send("POST", "/site/glass/breakages", {
            areaId: dispatch,
            itemId: lamp,
            description: "x",
            quarantined: "y",
          }),
          400,
        ),
      ).toBe("invalid_input");
      const release = (call: (path: string, body: unknown) => Promise<Response>) =>
        call(`/site/glass/breakages/${breakage.id}/release`, {});
      expect(await error(await release((p, b) => viaToken(agentToken, "POST", p, b)), 403)).toBe(
        "token_not_allowed",
      );
      expect(await error(await release((p, b) => as(marcus.cookie).send("POST", p, b)), 403)).toBe(
        "module_forbidden",
      );
      // The clean-down must be recorded first.
      expect(await error(await release((p, b) => as(ada).send("POST", p, b)), 409)).toBe(
        "clean_down_missing",
      );
      const cleaned = await ok(
        await viaToken(agentToken, "PATCH", `/site/glass/breakages/${breakage.id}`, {
          cleanDown: "Line stripped, vacuumed, swabbed",
        }),
      );
      expect(cleaned).toMatchObject({ cleanDown: expect.any(String), cleanDownAt: expect.any(String) });
      // Saving the same clean-down again (the web form resends it) keeps who did it and when.
      const resaved = await ok(
        await as(ada).send("PATCH", `/site/glass/breakages/${breakage.id}`, {
          quarantined: "Line 1 product from 09:00 to 09:45",
          cleanDown: "Line stripped, vacuumed, swabbed",
        }),
      );
      expect(resaved).toMatchObject({
        cleanDownAt: cleaned.cleanDownAt,
        cleanDownByName: cleaned.cleanDownByName,
      });
      const released = await ok(await release((p, b) => as(ada).send("POST", p, b)));
      expect(released).toMatchObject({
        status: "released",
        releasedByName: expect.any(String),
        releasedAt: expect.any(String),
      });
      expect(await error(await release((p, b) => as(ada).send("POST", p, b)), 409)).toBe("already_released");
      expect(
        await error(
          await as(ada).send("PATCH", `/site/glass/breakages/${breakage.id}`, { quarantined: "later" }),
          409,
        ),
      ).toBe("breakage_released");
      expect((await due()).counts.openBreakages).toBe(0);
    });
  });

  describe("planned maintenance", () => {
    let oven: string;
    let task: string;
    let greasing: string;
    let record: string;

    it("keeps assets and tasks; a hygiene clearance needs the asset's area", async () => {
      const noArea = (
        await ok(
          await viaToken(agentToken, "POST", "/assets", { kind: "equipment", code: "MX-1", name: "Mixer" }),
          201,
        )
      ).id;
      expect(
        await error(
          await as(ada).send("POST", "/site/maintenance/tasks", {
            assetId: noArea,
            title: "Strip",
            frequency: { every: 3, unit: "month" },
            clearanceRequired: true,
          }),
          400,
        ),
      ).toBe("invalid_input");
      oven = (
        await ok(
          await as(ada).send("POST", "/assets", {
            kind: "equipment",
            code: "OV-1",
            name: "Oven 1",
            parentAreaId: packing,
          }),
          201,
        )
      ).id;
      expect(
        await error(
          await as(ada).send("POST", "/assets", { kind: "equipment", code: "ov-1", name: "Oven 2" }),
          409,
        ),
      ).toBe("code_taken");
      task = (
        await ok(
          await viaToken(agentToken, "POST", "/site/maintenance/tasks", {
            assetId: oven,
            title: "Replace door seals",
            frequency: { every: 3, unit: "month" },
            startOn: dateAgo(2),
            clearanceRequired: true,
          }),
          201,
        )
      ).id;
      greasing = (
        await ok(
          await as(ada).send("POST", "/site/maintenance/tasks", {
            assetId: oven,
            title: "Grease bearings",
            frequency: { every: 1, unit: "month" },
          }),
          201,
        )
      ).id;
      const d = await due();
      expect(d.items.find((i) => i.subjectId === task)).toMatchObject({
        programme: "maintenance",
        state: "overdue",
      });
      expect(d.items.find((i) => i.subjectId === greasing)).toMatchObject({ state: "due", dueOn: null });
    });

    it("records completed maintenance as a person and schedules the next one", async () => {
      expect(
        await error(
          await viaToken(agentToken, "POST", "/site/maintenance/records", { taskId: greasing }),
          403,
        ),
      ).toBe("token_not_allowed");
      const done = await ok(
        await as(marcus.cookie).send("POST", "/site/maintenance/records", {
          taskId: greasing,
          workDone: "Greased",
          completedAt: daysAgo(40),
        }),
        201,
      );
      expect(done).toMatchObject({
        clearanceRequired: false,
        awaitingClearance: false,
        doneBy: marcus.userId,
      });
      const d = await due();
      expect(d.items.find((i) => i.subjectId === greasing)).toMatchObject({ state: "overdue" });
      expect(
        await error(
          await as(marcus.cookie).send("POST", "/site/maintenance/records", {
            taskId: greasing,
            completedAt: daysAgo(1),
            nextDueOn: dateAgo(3),
          }),
          400,
        ),
      ).toBe("invalid_input");
      const again = await ok(
        await as(marcus.cookie).send("POST", "/site/maintenance/records", { taskId: greasing }),
        201,
      );
      expect(again.nextDueOn > dateAhead(27)).toBe(true);
      expect((await due()).items.find((i) => i.subjectId === greasing)).toMatchObject({
        state: expect.stringMatching(/ok|soon/),
      });
    });

    it("needs a person's hygiene clearance after work in a production area", async () => {
      record = (
        await ok(
          await as(marcus.cookie).send("POST", "/site/maintenance/records", {
            taskId: task,
            contractor: "Oven Co",
            workDone: "Seals replaced",
          }),
          201,
        )
      ).id;
      const rec = await ok(await as(ada).get(`/site/maintenance/records/${record}`));
      expect(rec).toMatchObject({
        clearanceRequired: true,
        clearedAt: null,
        awaitingClearance: true,
        area: { name: "Packing hall" },
      });
      expect((await due()).counts.awaitingClearance).toBe(1);
      const clear = (call: (p: string, b: unknown) => Promise<Response>) =>
        call(`/site/maintenance/records/${record}/clearance`, { note: "Swabbed, ATP pass" });
      expect(await error(await clear((p, b) => viaToken(agentToken, "POST", p, b)), 403)).toBe(
        "token_not_allowed",
      );
      expect(await error(await clear((p, b) => as(marcus.cookie).send("POST", p, b)), 403)).toBe(
        "module_forbidden",
      );
      const cleared = await ok(await clear((p, b) => as(ada).send("POST", p, b)));
      expect(cleared).toMatchObject({
        awaitingClearance: false,
        clearedByName: expect.any(String),
        clearanceNote: "Swabbed, ATP pass",
      });
      expect(await error(await clear((p, b) => as(ada).send("POST", p, b)), 409)).toBe("already_cleared");
      const noNeed = (await ok(await as(ada).get(`/site/maintenance/records?taskId=${greasing}&limit=1`)))
        .records[0];
      expect(
        await error(await as(ada).send("POST", `/site/maintenance/records/${noNeed.id}/clearance`, {}), 409),
      ).toBe("clearance_not_required");
    });

    it("corrects a record with a new row, which needs its own clearance", async () => {
      const fixed = await ok(
        await as(marcus.cookie).send("POST", `/site/maintenance/records/${record}/correct`, {
          reason: "Wrong contractor",
          contractor: "Seals Ltd",
          workDone: "Seals replaced",
        }),
        201,
      );
      expect(fixed).toMatchObject({ correctsRecordId: record, clearedAt: null, awaitingClearance: true });
      expect(
        await error(await as(ada).send("POST", `/site/maintenance/records/${record}/clearance`, {}), 409),
      ).toBe("already_corrected");
      expect(
        await error(
          await as(marcus.cookie).send("POST", `/site/maintenance/records/${record}/correct`, {
            reason: "x",
          }),
          409,
        ),
      ).toBe("already_corrected");
      await ok(await as(ada).send("POST", `/site/maintenance/records/${fixed.id}/clearance`, {}));
      const { records } = await ok(await as(ada).get(`/site/maintenance/records?awaitingClearance=true`));
      expect(records).toHaveLength(0);
    });

    it("corrects as a patch: keeps when, by whom, the next due date and the clearance", async () => {
      const original = await ok(
        await as(marcus.cookie).send("POST", "/site/maintenance/records", {
          taskId: task,
          completedAt: daysAgo(40),
          contractor: "Oven Co",
          workDone: "Seals",
        }),
        201,
      );
      // The task stops needing a clearance after the work was done: the correction still needs one.
      await ok(
        await viaToken(agentToken, "PATCH", `/site/maintenance/tasks/${task}`, { clearanceRequired: false }),
      );
      const fixed = await ok(
        await as(ada).send("POST", `/site/maintenance/records/${original.id}/correct`, {
          reason: "Typo",
          workDone: "Seals replaced",
        }),
        201,
      );
      expect(fixed).toMatchObject({
        correctsRecordId: original.id,
        completedAt: original.completedAt,
        doneBy: marcus.userId,
        contractor: "Oven Co",
        workDone: "Seals replaced",
        nextDueOn: original.nextDueOn,
        clearanceRequired: true,
        awaitingClearance: true,
      });
      await ok(
        await viaToken(agentToken, "PATCH", `/site/maintenance/tasks/${task}`, { clearanceRequired: true }),
      );
      await ok(await as(ada).send("POST", `/site/maintenance/records/${fixed.id}/clearance`, {}));
    });

    it("corrects a record on equipment retired since", async () => {
      const mixer = (
        await ok(
          await as(ada).send("POST", "/assets", { kind: "equipment", code: "MX-9", name: "Old mixer" }),
          201,
        )
      ).id;
      const service = (
        await ok(
          await as(ada).send("POST", "/site/maintenance/tasks", {
            assetId: mixer,
            title: "Service",
            frequency: { every: 12, unit: "month" },
          }),
          201,
        )
      ).id;
      const done = await ok(
        await as(marcus.cookie).send("POST", "/site/maintenance/records", {
          taskId: service,
          workDone: "Serviced",
        }),
        201,
      );
      await ok(await as(ada).send("POST", `/assets/${mixer}/archive`, {}));
      expect(
        await error(
          await as(marcus.cookie).send("POST", "/site/maintenance/records", { taskId: service }),
          409,
        ),
      ).toMatch(/archived/);
      await ok(
        await as(marcus.cookie).send("POST", `/site/maintenance/records/${done.id}/correct`, {
          reason: "Wrong notes",
          workDone: "Serviced, belts replaced",
        }),
        201,
      );
    });
  });

  describe("storage temperatures", () => {
    let chiller: string;
    let freezer: string;

    it("keeps units with limits", async () => {
      chiller = (
        await ok(
          await as(ada).send("POST", "/site/storage/units", {
            code: "CH-1",
            name: "Chiller 1",
            kind: "chiller",
            limitMin: 0,
            limitMax: 5,
            areaId: packing,
            readingFrequency: { every: 1, unit: "day" },
          }),
          201,
        )
      ).id;
      freezer = (
        await ok(
          await viaToken(agentToken, "POST", "/site/storage/units", {
            name: "Freezer 1",
            kind: "freezer",
            limitMax: -18,
          }),
          201,
        )
      ).id;
      expect(
        await error(await as(ada).send("POST", "/site/storage/units", { name: "Bad", kind: "chiller" }), 400),
      ).toBe("invalid_input");
      const { units } = await ok(await as(ada).get("/site/storage/units"));
      expect(units.find((u: { id: string }) => u.id === chiller)).toMatchObject({
        limitsText: "0 to 5 °C",
        due: { state: "due" },
      });
    });

    it("takes a person's reading as approved and a token's as pending, flagging out-of-limit ones", async () => {
      const person = await ok(
        await as(marcus.cookie).send("POST", "/site/storage/readings", { unitId: chiller, value: 3.5 }),
        201,
      );
      expect(person).toMatchObject({
        withinLimits: true,
        source: "manual",
        reviewStatus: "approved",
        reviewedBy: marcus.userId,
        correctiveActions: [],
      });
      const agent = await ok(
        await viaToken(agentToken, "POST", "/site/storage/readings", { unitId: freezer, value: -20 }),
        201,
      );
      expect(agent).toMatchObject({
        withinLimits: true,
        source: "api",
        reviewStatus: "pending",
        reviewedBy: null,
      });
      const edge = await ok(
        await as(marcus.cookie).send("POST", "/site/storage/readings", {
          unitId: chiller,
          value: 5,
          checkedAt: daysAgo(0.5),
        }),
        201,
      );
      expect(edge.withinLimits).toBe(true);
      expect(
        await error(
          await as(marcus.cookie).send("POST", "/site/storage/readings", {
            unitId: chiller,
            value: 4,
            checkedAt: new Date(Date.now() + 3 * 3_600_000).toISOString(),
          }),
          400,
        ),
      ).toBe("invalid_input");
    });

    let excursion: { id: string; correctiveActions: { id: string }[] };
    it("opens a corrective action at once for an out-of-limit reading, even from a token", async () => {
      excursion = await ok(
        await viaToken(agentToken, "POST", "/site/storage/readings", {
          unitId: chiller,
          value: 8.5,
          note: "Door left open",
          correctiveAction: { actionTaken: "Product probed and moved" },
        }),
        201,
      );
      expect(excursion).toMatchObject({
        withinLimits: false,
        deviationReason: "above_max",
        reviewStatus: "pending",
        limitsText: "0 to 5 °C",
      });
      expect(excursion.correctiveActions).toHaveLength(1);
      const action = await ok(await as(ada).get(`/site/actions/${excursion.correctiveActions[0]!.id}`));
      expect(action).toMatchObject({
        status: "open",
        source: "api",
        reading: { text: "8.5 °C" },
        missing: ["rootCause", "preventiveAction"],
      });
      const d = await due();
      expect(d.counts.openActions).toBe(1);
      expect(d.counts.awaitingReview).toBe(2);
    });

    it("keeps the limits a reading was judged against when the unit's limits change", async () => {
      await ok(await as(ada).send("PATCH", `/site/storage/units/${chiller}`, { limitMax: 8 }));
      const reading = await ok(await as(ada).get(`/site/storage/readings/${excursion.id}`));
      expect(reading).toMatchObject({ withinLimits: false, limitMax: 5 });
      await ok(await as(ada).send("PATCH", `/site/storage/units/${chiller}`, { limitMax: 5 }));
      expect(
        await error(await as(ada).send("PATCH", `/site/storage/units/${chiller}`, { limitMin: 6 }), 400),
      ).toBe("invalid_input");
    });

    it("lets only a person with manage review readings a token recorded", async () => {
      const { readings } = await ok(await as(ada).get("/site/storage/readings?review=pending"));
      expect(readings).toHaveLength(2);
      const review = (call: (p: string, b: unknown) => Promise<Response>, id: string, body: object) =>
        call(`/site/storage/readings/${id}/review`, body);
      expect(
        await error(
          await review((p, b) => viaToken(agentToken, "POST", p, b), excursion.id, { decision: "approve" }),
          403,
        ),
      ).toBe("token_not_allowed");
      expect(
        await error(
          await review((p, b) => as(marcus.cookie).send("POST", p, b), excursion.id, { decision: "approve" }),
          403,
        ),
      ).toBe("module_forbidden");
      expect(
        await error(
          await review((p, b) => as(ada).send("POST", p, b), excursion.id, { decision: "reject" }),
          400,
        ),
      ).toBe("invalid_input");
      expect(
        await error(
          await as(marcus.cookie).send("POST", "/site/storage/readings/review", {
            ids: [excursion.id],
            decision: "approve",
          }),
          403,
        ),
      ).toBe("module_forbidden");
      expect(
        await error(
          await viaToken(agentToken, "POST", "/site/storage/readings/review", {
            ids: [excursion.id],
            decision: "approve",
          }),
          403,
        ),
      ).toBe("token_not_allowed");
      const approved = await ok(
        await review((p, b) => as(ada).send("POST", p, b), excursion.id, {
          decision: "approve",
          note: "Seen on the logger",
        }),
      );
      expect(approved).toMatchObject({
        reviewStatus: "approved",
        reviewedByName: expect.any(String),
        reviewNote: "Seen on the logger",
      });
      expect(
        await error(
          await review((p, b) => as(ada).send("POST", p, b), excursion.id, { decision: "approve" }),
          409,
        ),
      ).toBe("already_reviewed");
      // Approving the deviation's reading doesn't close its corrective action.
      expect(
        (await ok(await as(ada).get(`/site/actions/${excursion.correctiveActions[0]!.id}`))).status,
      ).toBe("open");
    });

    it("makes the check due again when a person rejects a reading", async () => {
      const unit = async () =>
        (await ok(await as(ada).get("/site/storage/units"))).units.find(
          (u: { id: string }) => u.id === freezer,
        );
      // The freezer's only reading is the pending token reading, which counts as done.
      expect(["ok", "soon"]).toContain((await unit()).due.state);
      const { readings } = await ok(await as(ada).get(`/site/storage/readings?unitId=${freezer}`));
      const bulk = await ok(
        await as(ada).send("POST", "/site/storage/readings/review", {
          ids: [readings[0].id],
          decision: "reject",
          note: "Probe was in the door",
        }),
      );
      expect(bulk.reviewed).toBe(1);
      expect((await unit()).due.state).toBe("due");
    });

    it("corrects a reading with a new row; correcting an out-of-limit one needs manage", async () => {
      const within = (
        await ok(await as(ada).get(`/site/storage/readings?unitId=${chiller}&outOfLimits=false&limit=1`))
      ).readings[0];
      expect(
        await error(
          await viaToken(agentToken, "POST", `/site/storage/readings/${within.id}/correct`, {
            value: 4,
            reason: "x",
          }),
          403,
        ),
      ).toBe("token_not_allowed");
      expect(
        await error(
          await as(marcus.cookie).send("POST", `/site/storage/readings/${excursion.id}/correct`, {
            value: 4,
            reason: "Misread",
          }),
          403,
        ),
      ).toBe("module_forbidden");
      const fixed = await ok(
        await as(marcus.cookie).send("POST", `/site/storage/readings/${within.id}/correct`, {
          value: 4.1,
          reason: "Misread",
        }),
        201,
      );
      expect(fixed).toMatchObject({
        correctsReadingId: within.id,
        reviewStatus: "approved",
        checkedAt: within.checkedAt,
      });
      // A correction that is still out of limits reuses the deviation's corrective action.
      const again = await ok(
        await as(ada).send("POST", `/site/storage/readings/${excursion.id}/correct`, {
          value: 7,
          reason: "Logger offset",
        }),
        201,
      );
      expect(again).toMatchObject({ withinLimits: false, correctsReadingId: excursion.id });
      expect(again.correctiveActions).toHaveLength(0);
      const { actions } = await ok(await as(ada).get(`/site/actions?readingId=${excursion.id}`));
      expect(actions).toHaveLength(1);
      expect(
        await error(
          await as(ada).send("POST", `/site/storage/readings/${excursion.id}/correct`, {
            value: 4,
            reason: "again",
          }),
          409,
        ),
      ).toBe("already_corrected");
      const list = await ok(
        await as(ada).get(`/site/storage/readings?unitId=${chiller}&includeCorrected=false`),
      );
      expect(list.readings.find((r: { id: string }) => r.id === excursion.id)).toBeUndefined();
      expect((await as(ada).send("DELETE", `/site/storage/readings/${excursion.id}`)).status).toBe(404);
    });

    it("closes a corrective action only once it is filled in, and only by a person with manage", async () => {
      const id = excursion.correctiveActions[0]!.id;
      expect(await error(await viaToken(agentToken, "POST", `/site/actions/${id}/close`, {}), 403)).toBe(
        "token_not_allowed",
      );
      expect(await error(await as(marcus.cookie).send("POST", `/site/actions/${id}/close`, {}), 403)).toBe(
        "module_forbidden",
      );
      expect(await error(await as(ada).send("POST", `/site/actions/${id}/close`, {}), 409)).toBe(
        "site_action_incomplete",
      );
      await ok(
        await viaToken(agentToken, "PATCH", `/site/actions/${id}`, {
          rootCause: "Door left ajar",
          preventiveAction: "Door closer fitted",
        }),
      );
      const closed = await ok(await as(ada).send("POST", `/site/actions/${id}/close`, { note: "Verified" }));
      expect(closed).toMatchObject({ status: "closed", closedByName: expect.any(String), missing: [] });
      expect(await error(await as(ada).send("PATCH", `/site/actions/${id}`, { rootCause: "x" }), 409)).toBe(
        "site_action_closed",
      );
      expect(await error(await as(ada).send("POST", `/site/actions/${id}/close`, {}), 409)).toBe(
        "site_action_closed",
      );
    });

    it("lets an agent propose an action, but only for an out-of-limit reading", async () => {
      const within = (
        await ok(await as(ada).get(`/site/storage/readings?unitId=${chiller}&outOfLimits=false&limit=1`))
      ).readings[0];
      expect(
        await error(
          await viaToken(agentToken, "POST", "/site/actions", { title: "x", readingId: within.id }),
          400,
        ),
      ).toBe("invalid_input");
      const free = await ok(
        await viaToken(agentToken, "POST", "/site/actions", { title: "Chiller 1 door seal worn" }),
        201,
      );
      expect(free).toMatchObject({ source: "api", reading: null });
    });

    it("keeps one open action per reading, and reopens one when a correction is still out of limits", async () => {
      const warm = await ok(
        await as(ada).send("POST", "/site/storage/readings", { unitId: chiller, value: 9 }),
        201,
      );
      const actionId = warm.correctiveActions[0]!.id;
      expect(
        await error(
          await viaToken(agentToken, "POST", "/site/actions", { title: "Again", readingId: warm.id }),
          409,
        ),
      ).toBe("site_action_exists");
      await ok(
        await as(ada).send("PATCH", `/site/actions/${actionId}`, {
          actionTaken: "Moved stock",
          rootCause: "Defrost cycle",
          preventiveAction: "Defrost timer moved",
        }),
      );
      await ok(await as(ada).send("POST", `/site/actions/${actionId}/close`, {}));
      // The excursion was worse than written: the closed action doesn't cover the correction.
      const fixed = await ok(
        await as(ada).send("POST", `/site/storage/readings/${warm.id}/correct`, {
          reason: "Misread",
          value: 12,
        }),
        201,
      );
      expect(fixed.withinLimits).toBe(false);
      expect(fixed.correctiveActions).toEqual([expect.objectContaining({ status: "open" })]);
      expect(fixed.correctiveActions[0].id).not.toBe(actionId);
    });

    it("refuses to record against an archived unit", async () => {
      const spare = (
        await ok(
          await as(ada).send("POST", "/site/storage/units", { name: "Spare", kind: "ambient", limitMax: 25 }),
          201,
        )
      ).id;
      await ok(await as(ada).send("PATCH", `/site/storage/units/${spare}`, { status: "archived" }));
      expect(
        await error(await as(ada).send("POST", "/site/storage/readings", { unitId: spare, value: 20 }), 409),
      ).toBe("unit_archived");
    });
  });

  describe("pre-start and allergen changeover checks", () => {
    let prestart: { id: string; items: { id: string; prompt: string }[] };
    let changeover: { id: string; items: { id: string }[] };
    const results = (list: { id: string }[], over: Record<number, object> = {}) =>
      list.map((item, i) => ({ itemId: item.id, result: "pass", ...(over[i] ?? {}) }));

    it("keeps checklists per line or area; items can't repeat", async () => {
      prestart = await ok(
        await viaToken(agentToken, "POST", "/site/checklists/templates", {
          name: "Line 1 pre-start",
          kind: "prestart",
          areaId: packing,
          line: "Line 1",
          frequency: { every: 1, unit: "day" },
          items: [
            { prompt: "Metal detector tested" },
            { prompt: "Floor clean and dry", guidance: "No standing water" },
            { prompt: "No loose items" },
          ],
        }),
        201,
      );
      expect(prestart.items.map((i) => i.prompt)).toEqual([
        "Metal detector tested",
        "Floor clean and dry",
        "No loose items",
      ]);
      changeover = await ok(
        await as(ada).send("POST", "/site/checklists/templates", {
          name: "Allergen changeover",
          kind: "allergen_changeover",
          items: [{ prompt: "Line stripped and cleaned" }, { prompt: "Allergen swab negative" }],
        }),
        201,
      );
      expect(
        await error(
          await as(ada).send("POST", "/site/checklists/templates", {
            name: "x",
            kind: "prestart",
            items: [{ prompt: "A" }, { prompt: "a" }],
          }),
          400,
        ),
      ).toBe("invalid_input");
      expect(
        await error(
          await as(ada).send("POST", "/site/checklists/templates", {
            name: "x",
            kind: "prestart",
            duringProduction: true,
            items: [{ prompt: "A" }],
          }),
          400,
        ),
      ).toBe("invalid_input");
      expect((await due()).items.find((i) => i.subjectId === prestart.id)).toMatchObject({
        programme: "checklist",
        state: "due",
      });
    });

    it("records a check as a person: a result for every item, a note for a failure", async () => {
      const body = { templateId: prestart.id, results: results(prestart.items) };
      expect(await error(await viaToken(agentToken, "POST", "/site/checklists/checks", body), 403)).toBe(
        "token_not_allowed",
      );
      expect(
        await error(
          await as(marcus.cookie).send("POST", "/site/checklists/checks", {
            ...body,
            results: body.results.slice(1),
          }),
          400,
        ),
      ).toBe("invalid_input");
      expect(
        await error(
          await as(marcus.cookie).send("POST", "/site/checklists/checks", {
            ...body,
            results: results(prestart.items, { 1: { result: "fail" } }),
          }),
          400,
        ),
      ).toBe("invalid_input");
      expect(
        await error(
          await as(marcus.cookie).send("POST", "/site/checklists/checks", {
            ...body,
            previousBatchId: batchBefore,
          }),
          400,
        ),
      ).toBe("invalid_input");
      const check = await ok(await as(marcus.cookie).send("POST", "/site/checklists/checks", body), 201);
      expect(check).toMatchObject({
        outcome: "passed",
        signOffStatus: "pending",
        awaitingSignOff: true,
        templateName: "Line 1 pre-start",
        failedCount: 0,
        area: { name: "Packing hall" },
      });
      expect(check.results.map((r: { prompt: string }) => r.prompt)).toEqual(
        prestart.items.map((i) => i.prompt),
      );
      // A passed check waiting for sign-off counts as done.
      expect((await due()).items.find((i) => i.subjectId === prestart.id)?.state).toMatch(/ok|soon/);
      expect((await due()).counts.awaitingSignOff).toBe(1);
    });

    it("signs a check off before production starts: manage and a person only", async () => {
      const { checks } = await ok(await as(ada).get("/site/checklists/checks?signOff=pending"));
      const id = checks[0].id;
      const signOff = (call: (p: string, b: unknown) => Promise<Response>, body: object) =>
        call(`/site/checklists/checks/${id}/sign-off`, body);
      expect(
        await error(
          await signOff((p, b) => viaToken(agentToken, "POST", p, b), { decision: "approve" }),
          403,
        ),
      ).toBe("token_not_allowed");
      expect(
        await error(
          await signOff((p, b) => as(marcus.cookie).send("POST", p, b), { decision: "approve" }),
          403,
        ),
      ).toBe("module_forbidden");
      expect(
        await error(await signOff((p, b) => as(ada).send("POST", p, b), { decision: "reject" }), 400),
      ).toBe("invalid_input");
      const signed = await ok(
        await signOff((p, b) => as(ada).send("POST", p, b), { decision: "approve", note: "Good to run" }),
      );
      expect(signed).toMatchObject({
        signOffStatus: "approved",
        signedOffByName: expect.any(String),
        awaitingSignOff: false,
      });
      expect(
        await error(await signOff((p, b) => as(ada).send("POST", p, b), { decision: "approve" }), 409),
      ).toBe("already_signed_off");
    });

    it("can only hold a failed check, and a held check is due again", async () => {
      const failed = await ok(
        await as(marcus.cookie).send("POST", "/site/checklists/checks", {
          templateId: prestart.id,
          results: results(prestart.items, {
            0: { result: "fail", note: "Detector failed test piece; engineer called" },
          }),
        }),
        201,
      );
      expect(failed).toMatchObject({ outcome: "failed", failedCount: 1 });
      expect((await due()).items.find((i) => i.subjectId === prestart.id)?.state).toMatch(/ok|soon/);
      expect(
        await error(
          await as(ada).send("POST", `/site/checklists/checks/${failed.id}/sign-off`, {
            decision: "approve",
          }),
          409,
        ),
      ).toBe("check_failed");
      const held = await ok(
        await as(ada).send("POST", `/site/checklists/checks/${failed.id}/sign-off`, {
          decision: "reject",
          note: "Hold until the detector is fixed",
        }),
      );
      expect(held).toMatchObject({ signOffStatus: "rejected" });
    });

    it("refers an allergen changeover to the batches before and after it", async () => {
      const body = {
        templateId: changeover.id,
        results: results(changeover.items),
        previousBatchId: batchBefore,
        nextBatchId: batchAfter,
      };
      expect(
        await error(
          await as(marcus.cookie).send("POST", "/site/checklists/checks", {
            ...body,
            nextBatchId: batchBefore,
          }),
          400,
        ),
      ).toBe("invalid_input");
      expect(
        await error(
          await as(marcus.cookie).send("POST", "/site/checklists/checks", {
            ...body,
            nextBatchId: "0190a1a0-0000-7000-8000-0000000000aa",
          }),
          404,
        ),
      ).toBe("not_found");
      const check = await ok(await as(marcus.cookie).send("POST", "/site/checklists/checks", body), 201);
      expect(check.previousBatch.id).toBe(batchBefore);
      expect(check.nextBatch.id).toBe(batchAfter);
      const byBatch = await ok(await as(ada).get(`/site/checklists/checks?batchId=${batchAfter}`));
      expect(byBatch.checks.map((c: { id: string }) => c.id)).toEqual([check.id]);
      // A changeover has no schedule: it is never due.
      expect((await due()).items.find((i) => i.subjectId === changeover.id)).toBeUndefined();
    });

    it("corrects a check with a new one, which needs its own sign-off", async () => {
      const { checks } = await ok(await as(ada).get(`/site/checklists/checks?templateId=${changeover.id}`));
      const original = checks[0];
      const body = {
        reason: "Swab result misread",
        results: results(changeover.items, { 1: { result: "fail", note: "Swab positive; re-cleaned" } }),
      };
      expect(
        await error(
          await viaToken(agentToken, "POST", `/site/checklists/checks/${original.id}/correct`, body),
          403,
        ),
      ).toBe("token_not_allowed");
      expect(
        await error(
          await as(marcus.cookie).send("POST", `/site/checklists/checks/${original.id}/correct`, {
            ...body,
            results: body.results.slice(1),
          }),
          400,
        ),
      ).toBe("invalid_input");
      const fixed = await ok(
        await as(marcus.cookie).send("POST", `/site/checklists/checks/${original.id}/correct`, body),
        201,
      );
      expect(fixed).toMatchObject({
        correctsCheckId: original.id,
        outcome: "failed",
        signOffStatus: "pending",
        previousBatchId: batchBefore,
        nextBatchId: batchAfter,
      });
      expect(
        await error(
          await as(ada).send("POST", `/site/checklists/checks/${original.id}/sign-off`, {
            decision: "reject",
            note: "x",
          }),
          409,
        ),
      ).toBe("already_corrected");
      expect(
        await error(
          await as(marcus.cookie).send("POST", `/site/checklists/checks/${original.id}/correct`, body),
          409,
        ),
      ).toBe("already_corrected");
      const list = await ok(
        await as(ada).get(`/site/checklists/checks?templateId=${changeover.id}&includeCorrected=false`),
      );
      expect(list.checks.map((c: { id: string }) => c.id)).toEqual([fixed.id]);
    });

    it("keeps the wording of past checks when the checklist is edited", async () => {
      const { checks } = await ok(
        await as(ada).get(`/site/checklists/checks?templateId=${prestart.id}&limit=1`),
      );
      const [first, second, third] = prestart.items;
      const edited = await ok(
        await as(ada).send("PATCH", `/site/checklists/templates/${prestart.id}`, {
          items: [
            { id: second!.id, prompt: "Floor clean, dry and free of debris" },
            { id: first!.id, prompt: first!.prompt },
            { prompt: "Hand-wash stations stocked" },
          ],
        }),
      );
      expect(edited.items.map((i: { prompt: string }) => i.prompt)).toEqual([
        "Floor clean, dry and free of debris",
        "Metal detector tested",
        "Hand-wash stations stocked",
      ]);
      expect(edited.items.find((i: { id: string }) => i.id === third!.id)).toBeUndefined();
      const old = await ok(await as(ada).get(`/site/checklists/checks/${checks[0].id}`));
      expect(old.results.map((r: { prompt: string }) => r.prompt)).toContain("No loose items");
      expect(
        await error(
          await as(ada).send("PATCH", `/site/checklists/templates/${prestart.id}`, {
            items: [{ id: "0190a1a0-0000-7000-8000-0000000000aa", prompt: "x" }],
          }),
          400,
        ),
      ).toBe("invalid_input");
      // Checks against the old list no longer apply: every item of the new list needs a result.
      expect(
        await error(
          await as(marcus.cookie).send("POST", "/site/checklists/checks", {
            templateId: prestart.id,
            results: results(prestart.items),
          }),
          400,
        ),
      ).toBe("invalid_input");
    });
  });

  describe("an open glass breakage holds its area", () => {
    it("refuses sign-off of pre-start and changeover checks in the area until the breakage is released", async () => {
      const template = async (kind: string, name: string) =>
        (await ok(
          await as(ada).send("POST", "/site/checklists/templates", {
            name,
            kind,
            areaId: dispatch,
            items: [{ prompt: "Done" }],
          }),
          201,
        )) as { id: string; items: { id: string }[] };
      const record = async (t: { id: string; items: { id: string }[] }) =>
        (await ok(
          await as(marcus.cookie).send("POST", "/site/checklists/checks", {
            templateId: t.id,
            results: t.items.map((i) => ({ itemId: i.id, result: "pass" })),
          }),
          201,
        )) as { id: string };
      const prestartHere = await template("prestart", "Dispatch pre-start");
      const changeoverHere = await template("allergen_changeover", "Dispatch changeover");
      const breakage = await ok(
        await viaToken(agentToken, "POST", "/site/glass/breakages", {
          areaId: dispatch,
          description: "Light cover cracked over the dock",
          quarantined: "Pallets at door 2",
        }),
        201,
      );
      // Recording is allowed while the area is held; only the sign-off is blocked.
      const a = await record(prestartHere);
      const b = await record(changeoverHere);
      const held = await ok(await as(ada).get(`/site/checklists/checks/${a.id}`));
      expect(held.areaHold).toMatchObject({
        id: breakage.id,
        description: "Light cover cracked over the dock",
      });
      for (const check of [a, b]) {
        const res = await as(ada).send("POST", `/site/checklists/checks/${check.id}/sign-off`, {
          decision: "approve",
        });
        const body = await res.json();
        expect(res.status, JSON.stringify(body)).toBe(409);
        expect(body.error.code).toBe("area_on_hold");
        expect(body.error.message).toContain("Light cover cracked over the dock");
      }
      await ok(
        await as(ada).send("PATCH", `/site/glass/breakages/${breakage.id}`, {
          cleanDown: "Cleaned and swept",
        }),
      );
      await ok(await as(ada).send("POST", `/site/glass/breakages/${breakage.id}/release`, {}));
      for (const check of [a, b]) {
        const signed = await ok(
          await as(ada).send("POST", `/site/checklists/checks/${check.id}/sign-off`, { decision: "approve" }),
        );
        expect(signed).toMatchObject({ signOffStatus: "approved", areaHold: null });
      }
    });
  });

  describe("what is due across the programmes", () => {
    it("lists overdue and due items first, and only those by default", async () => {
      const all = await due("include=all");
      const actionable = await due("include=due");
      expect(actionable.items.every((i) => i.state === "overdue" || i.state === "due")).toBe(true);
      expect(actionable.items.length).toBeLessThan(all.items.length);
      expect(all.items.map((i) => i.programme)).toEqual(
        expect.arrayContaining(["pest", "glass", "maintenance", "storage", "checklist"]),
      );
      const ranks = actionable.items.map((i) => (i.state === "overdue" ? 0 : 1));
      expect(ranks).toEqual([...ranks].sort());
      const onlyStorage = await due("include=all&programme=storage");
      expect(onlyStorage.items.every((i) => i.programme === "storage")).toBe(true);
    });
  });

  describe("sync and bootstrap", () => {
    it("writes records to the sync log for members who can read the module, and hides them from others", async () => {
      const changes = async (cookie: string) => {
        const res = await ok(await ctx.req(`${WS}/sync?after=0&limit=1000`, { cookie }));
        return res.changes.map((c: { entity: string }) => c.entity) as string[];
      };
      const entities = new Set(await changes(marcus.cookie));
      for (const e of [
        "site_pest_visit",
        "site_pest_finding",
        "site_glass_check",
        "site_glass_breakage",
        "site_maintenance_record",
        "site_storage_reading",
        "site_corrective_action",
        "site_checklist_check",
        "site_checklist_check_item",
        "site_checklist_item",
      ]) {
        expect(entities.has(e), e).toBe(true);
      }
      await grant("site", null);
      const hidden = (await changes(marcus.cookie)).filter((e) => e.startsWith("site_"));
      expect(hidden).toEqual([]);
    });
  });
});
