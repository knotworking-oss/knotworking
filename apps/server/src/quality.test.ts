import { DEFAULT_TIME_ZONE, todayInZone } from "@knotworking/core";
import { addDaysIso } from "@knotworking/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";

/** Today in the test workspaces' zone (the default, Europe/London), as the server decides it. */
const utcToday = () => todayInZone(DEFAULT_TIME_ZONE);

const WS = "/v1/workspaces/acme";

describe("quality module", () => {
  let ctx: TestCtx;
  let ada: string;
  let marcus: { cookie: string; userId: string };
  let token: string;
  const today = utcToday();
  const year = today.slice(0, 4);
  const as = (cookie: string) => ({
    get: (path: string) => ctx.req(`${WS}${path}`, { cookie }),
    send: (method: string, path: string, json?: unknown) => ctx.req(`${WS}${path}`, { method, cookie, json }),
  });
  const viaToken = (method: string, path: string, json?: unknown) =>
    ctx.req(`${WS}${path}`, { method, headers: { authorization: `Bearer ${token}`, origin: "" }, json });
  // Asserts the grant took, so a refused one fails here, not as a puzzling 403 tests later.
  const grant = async (moduleId: string, level: string | null) => {
    const res = await ctx.req(`${WS}/members/${marcus.userId}/module-access/${moduleId}`, {
      method: "PUT",
      cookie: ada,
      json: { level },
    });
    expect(res.status, `grant ${moduleId}=${level}: ${await res.clone().text()}`).toBe(200);
    return res;
  };
  const code = async (res: { json(): Promise<any> }) => (await res.json()).error.code;
  const ok = async (res: { status: number; json(): Promise<any> }, status = 200) => {
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(status);
    return body;
  };

  let flour: string;
  let cake: string;
  let flourLot: string;
  let cakeLot: string;

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    const { members } = await (await ctx.req(`${WS}/members`, { cookie: ada })).json();
    marcus = {
      userId: members.find((x: { email: string }) => x.email === "marcus@knotworking.dev").userId,
      cookie: (await signIn(ctx, "marcus@knotworking.dev")).cookie,
    };
    token = (
      await (
        await ctx.req("/v1/me/api-tokens", {
          method: "POST",
          cookie: ada,
          json: { name: "agent", scope: "write" },
        })
      ).json()
    ).token;
    const item = async (body: object) => (await ok(await as(ada).send("POST", "/items", body), 201)).id;
    flour = await item({ code: "FLR", name: "Flour", type: "ingredient", unit: "kg" });
    cake = await item({ code: "CAKE", name: "Cake", type: "finished", unit: "each" });
    const store = (await ok(await as(ada).send("POST", "/stock/locations", { name: "Store" }), 201)).id;
    const receive = async (itemId: string, quantity: number, unit: string) =>
      (
        await ok(
          await as(ada).send("POST", "/stock/receipts", {
            itemId,
            quantity,
            unit,
            locationId: store,
            receivedOn: today,
            reason: "Opening balance",
          }),
          201,
        )
      ).id;
    flourLot = await receive(flour, 25, "kg");
    cakeLot = await receive(cake, 480, "each");
  }, 60_000);
  afterAll(() => ctx.handle.close());

  describe("access", () => {
    it("is opt-in: members need a grant, and the module depends on items and stock", async () => {
      expect(await code(await as(marcus.cookie).get("/quality/summary"))).toBe("module_forbidden");
      await grant("quality", "write");
      // Quality needs items and stock to be readable.
      expect(await code(await as(marcus.cookie).get("/quality/summary"))).toBe("module_forbidden");
      await grant("items", "read");
      await grant("stock", "read");
      await ok(await as(marcus.cookie).get("/quality/summary"));
    });
  });

  describe("complaints", () => {
    let complaintId: string;

    it("logs a complaint with a yearly reference and keeps personal data out of the sync log", async () => {
      const complaint = await ok(
        await as(marcus.cookie).send("POST", "/quality/complaints", {
          receivedOn: today,
          source: "consumer",
          category: "quality",
          severity: "minor",
          complainantName: "Jo Bloggs",
          complainantContact: "jo@example.com",
          itemId: cake,
          lotId: cakeLot,
          reportedLotCode: "L-CAKE-1",
          description: "Cake was dry",
        }),
        201,
      );
      complaintId = complaint.id;
      expect(complaint).toMatchObject({
        reference: `CMP-${year}-001`,
        status: "open",
        complainantName: "Jo Bloggs",
        item: { id: cake, code: "CAKE" },
        lot: { id: cakeLot },
        nonconformances: [],
      });
      const page = await ok(await as(ada).get("/sync?after=0&limit=1000"));
      const change = page.changes.find((c: { entityId: string }) => c.entityId === complaintId);
      expect(change.data.description).toBe("Cake was dry");
      expect(change.data).not.toHaveProperty("complainantName");
      expect(change.data).not.toHaveProperty("complainantContact");
    });

    it("refuses future dates and a lot of another item", async () => {
      const base = { source: "customer", category: "other", description: "x" };
      expect(
        (await as(ada).send("POST", "/quality/complaints", { ...base, receivedOn: addDaysIso(today, 1) }))
          .status,
      ).toBe(400);
      expect(
        (
          await as(ada).send("POST", "/quality/complaints", {
            ...base,
            receivedOn: today,
            itemId: cake,
            lotId: flourLot,
          })
        ).status,
      ).toBe(400);
    });

    it("opens a non-conformance at once for a major food-safety complaint", async () => {
      const complaint = await ok(
        await viaToken("POST", "/quality/complaints", {
          receivedOn: today,
          source: "retailer",
          category: "foreign_body",
          severity: "major",
          customer: "Shop Ltd",
          itemId: cake,
          lotId: cakeLot,
          description: "Metal fragment found",
        }),
        201,
      );
      expect(complaint.reference).toBe(`CMP-${year}-002`);
      expect(complaint.nonconformances).toMatchObject([
        { reference: `NC-${year}-001`, severity: "major", status: "open", dueOn: addDaysIso(today, 28) },
      ]);
      const nc = await ok(await as(ada).get(`/quality/nonconformances/${complaint.nonconformances[0].id}`));
      expect(nc).toMatchObject({
        source: "complaint",
        complaint: { id: complaint.id, reference: complaint.reference },
        lot: { id: cakeLot },
        title: `Foreign body complaint ${complaint.reference}`,
      });
    });

    it("works a complaint, then a manager closes it in person once the response is on record", async () => {
      await ok(
        await as(marcus.cookie).send("PATCH", `/quality/complaints/${complaintId}`, {
          status: "investigating",
        }),
      );
      // Members with write can't close; tokens never can.
      expect(
        await code(await as(marcus.cookie).send("POST", `/quality/complaints/${complaintId}/close`, {})),
      ).toBe("module_forbidden");
      expect((await viaToken("POST", `/quality/complaints/${complaintId}/close`, {})).status).toBe(403);
      expect((await as(ada).send("POST", `/quality/complaints/${complaintId}/close`, {})).status).toBe(400);
      const closed = await ok(
        await as(ada).send("POST", `/quality/complaints/${complaintId}/close`, {
          response: "Refund sent",
          justified: true,
        }),
      );
      expect(closed).toMatchObject({ status: "closed", response: "Refund sent", justified: true });
      expect(closed.closedByName).toBeTruthy();
      expect(
        await code(
          await as(marcus.cookie).send("PATCH", `/quality/complaints/${complaintId}`, { description: "y" }),
        ),
      ).toBe("complaint_closed");
      const reopened = await ok(
        await as(ada).send("POST", `/quality/complaints/${complaintId}/reopen`, {
          reason: "Customer came back",
        }),
      );
      expect(reopened).toMatchObject({
        status: "investigating",
        closedAt: null,
        reopenReason: "Customer came back",
      });
    });

    it("filters the list", async () => {
      const unresolved = await ok(await as(ada).get("/quality/complaints?status=unresolved"));
      expect(unresolved.total).toBe(2);
      const search = await ok(await as(ada).get("/quality/complaints?q=metal"));
      expect(search.complaints.map((c: { category: string }) => c.category)).toEqual(["foreign_body"]);
      expect((await ok(await as(ada).get(`/quality/complaints?lotId=${cakeLot}`))).total).toBe(2);
    });
  });

  describe("non-conformances", () => {
    let ncId: string;

    it("raises one with a default due date by severity", async () => {
      const nc = await ok(
        await viaToken("POST", "/quality/nonconformances", {
          raisedOn: today,
          source: "process",
          severity: "minor",
          title: "Scale out of calibration",
          description: "Line 2 scale read 5 g heavy",
          ownerUserId: marcus.userId,
        }),
        201,
      );
      ncId = nc.id;
      expect(nc).toMatchObject({
        reference: `NC-${year}-002`,
        dueOn: addDaysIso(today, 56),
        overdue: false,
        owner: { id: marcus.userId },
      });
      // The source says where it came from: a complaint or an audit link needs the matching source.
      expect(
        (
          await as(ada).send("POST", "/quality/nonconformances", {
            raisedOn: today,
            source: "process",
            title: "x",
            description: "x",
            auditId: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
          })
        ).status,
      ).toBe(400);
    });

    it("needs the corrective action before it is taken, and the root cause before it is verified", async () => {
      expect(
        (
          await as(marcus.cookie).send("PATCH", `/quality/nonconformances/${ncId}`, {
            status: "action_taken",
          })
        ).status,
      ).toBe(400);
      const taken = await ok(
        await as(marcus.cookie).send("PATCH", `/quality/nonconformances/${ncId}`, {
          status: "action_taken",
          containment: "Weights rechecked",
          correctiveAction: "Recalibrated",
        }),
      );
      expect(taken.status).toBe("action_taken");
      expect(taken.actionTakenAt).toBeTruthy();
      const close = (cookie: string) =>
        as(cookie).send("POST", `/quality/nonconformances/${ncId}/close`, {
          verificationNote: "Checked a week on",
        });
      expect(await code(await close(marcus.cookie))).toBe("module_forbidden");
      expect((await close(ada)).status).toBe(400);
      await ok(
        await as(marcus.cookie).send("PATCH", `/quality/nonconformances/${ncId}`, {
          rootCause: "Worn load cell",
        }),
      );
      const closed = await ok(await close(ada));
      expect(closed).toMatchObject({ status: "closed", verificationNote: "Checked a week on" });
      expect(await code(await close(ada))).toBe("already_closed");
      expect(
        await code(await as(marcus.cookie).send("PATCH", `/quality/nonconformances/${ncId}`, { title: "y" })),
      ).toBe("nonconformance_closed");
    });

    it("lists overdue ones", async () => {
      const late = await ok(
        await as(ada).send("POST", "/quality/nonconformances", {
          raisedOn: addDaysIso(today, -10),
          source: "supplier",
          title: "Late delivery",
          description: "Chilled goods arrived warm",
          dueOn: addDaysIso(today, -1),
        }),
        201,
      );
      const overdue = await ok(await as(ada).get("/quality/nonconformances?status=overdue"));
      expect(overdue.nonconformances.map((n: { id: string }) => n.id)).toEqual([late.id]);
      expect(overdue.nonconformances[0].overdue).toBe(true);
    });
  });

  describe("audits", () => {
    let auditId: string;

    it("plans an audit and edits it while planned", async () => {
      const audit = await ok(
        await viaToken("POST", "/quality/audits", {
          title: "Hygiene and housekeeping",
          scope: "BRCGS 4.11",
          plannedOn: addDaysIso(today, 7),
          auditorUserId: marcus.userId,
        }),
        201,
      );
      auditId = audit.id;
      expect(audit).toMatchObject({
        reference: `IA-${addDaysIso(today, 7).slice(0, 4)}-001`,
        state: "soon",
        auditor: { id: marcus.userId },
        findings: { total: 0, open: 0 },
      });
      const renamed = await ok(
        await as(marcus.cookie).send("PATCH", `/quality/audits/${auditId}`, { auditorName: "External Ltd" }),
      );
      expect(renamed).toMatchObject({ auditorName: "External Ltd", auditorUserId: null });
    });

    it("completes in person, turning findings into non-conformances", async () => {
      expect(
        (await viaToken("POST", `/quality/audits/${auditId}/complete`, { completedOn: today, summary: "x" }))
          .status,
      ).toBe(403);
      // An outside auditor can't sign in: someone with manage records it, not any writer.
      expect(
        await code(
          await as(marcus.cookie).send("POST", `/quality/audits/${auditId}/complete`, {
            completedOn: today,
            summary: "x",
          }),
        ),
      ).toBe("not_auditor");
      const done = await ok(
        await as(ada).send("POST", `/quality/audits/${auditId}/complete`, {
          completedOn: today,
          summary: "Generally good",
          findings: [
            { title: "Cracked tile", description: "Floor by line 1", severity: "minor" },
            {
              title: "Hand wash sink blocked",
              description: "Low-risk area",
              severity: "major",
              ownerUserId: marcus.userId,
            },
          ],
        }),
      );
      expect(done).toMatchObject({
        status: "completed",
        state: "completed",
        findings: { total: 2, open: 2 },
      });
      expect(done.nonconformances.map((n: { reference: string }) => n.reference)).toEqual([
        `NC-${year}-004`,
        `NC-${year}-005`,
      ]);
      const findings = await ok(await as(ada).get(`/quality/nonconformances?auditId=${auditId}`));
      expect(findings.nonconformances.every((n: { source: string }) => n.source === "audit")).toBe(true);
      expect(await code(await as(ada).send("PATCH", `/quality/audits/${auditId}`, { title: "x" }))).toBe(
        "audit_not_planned",
      );
      expect(await code(await as(ada).send("DELETE", `/quality/audits/${auditId}`))).toBe(
        "audit_not_planned",
      );
    });

    it("cancels or deletes a planned audit", async () => {
      const plan = async () =>
        (
          await ok(
            await as(ada).send("POST", "/quality/audits", {
              title: "Pest",
              plannedOn: addDaysIso(today, -3),
            }),
            201,
          )
        ).id;
      const overdue = await plan();
      expect((await ok(await as(ada).get(`/quality/audits/${overdue}`))).state).toBe("overdue");
      const cancelled = await ok(
        await as(marcus.cookie).send("POST", `/quality/audits/${overdue}/cancel`, { reason: "Merged" }),
      );
      expect(cancelled.status).toBe("cancelled");
      const spare = await plan();
      expect((await as(ada).send("DELETE", `/quality/audits/${spare}`)).status).toBe(204);
      expect((await as(ada).get(`/quality/audits/${spare}`)).status).toBe(404);
    });
  });

  describe("recall tests", () => {
    it("records a test in person and works out the result", async () => {
      const body = {
        conductedOn: today,
        lotId: cakeLot,
        direction: "both",
        scenario: "Retailer reports metal",
        // 2 h 15 min, finished a minute ago.
        startedAt: new Date(Date.now() - 136 * 60_000).toISOString(),
        completedAt: new Date(Date.now() - 60_000).toISOString(),
        quantityExpected: 480,
        quantityTraced: 480,
      };
      expect((await viaToken("POST", "/quality/recall-tests", body)).status).toBe(403);
      const passed = await ok(await as(marcus.cookie).send("POST", "/quality/recall-tests", body), 201);
      expect(passed).toMatchObject({
        reference: `MR-${year}-001`,
        durationMinutes: 135,
        reconciledPercent: 100,
        passed: true,
        unit: "each",
        lot: { id: cakeLot, item: { id: cake } },
      });
      const failed = await ok(
        await as(marcus.cookie).send("POST", "/quality/recall-tests", { ...body, quantityTraced: 470 }),
        201,
      );
      expect(failed).toMatchObject({ reconciledPercent: 97.9, passed: false });
      expect(
        await code(
          await as(marcus.cookie).send("POST", `/quality/recall-tests/${failed.id}/void`, { reason: "x" }),
        ),
      ).toBe("module_forbidden");
      const voided = await ok(
        await as(ada).send("POST", `/quality/recall-tests/${failed.id}/void`, {
          reason: "Wrong lot counted",
        }),
      );
      expect(voided.voidReason).toBe("Wrong lot counted");
      expect((await ok(await as(ada).get("/quality/recall-tests"))).total).toBe(1);
      expect((await ok(await as(ada).get("/quality/recall-tests?includeVoided=true"))).total).toBe(2);
    });
  });

  describe("summary", () => {
    it("counts what needs attention", async () => {
      const summary = await ok(await as(ada).get("/quality/summary"));
      expect(summary.complaints).toMatchObject({ open: 1, investigating: 1, receivedLast30Days: 2 });
      expect(summary.nonconformances).toMatchObject({ open: 4, awaitingVerification: 0, overdue: 1 });
      expect(summary.audits).toMatchObject({ overdue: 0, completedLast12Months: 1 });
      expect(summary.recallTest).toMatchObject({ state: "ok", lastPassed: { passed: true } });
    });

    it("writes the sync log, filtered by module", async () => {
      const page = await ok(await as(ada).get("/sync?after=0&limit=1000"));
      const entities = new Set(page.changes.map((c: { entity: string }) => c.entity));
      for (const e of ["quality_complaint", "quality_nonconformance", "quality_audit", "quality_recall_test"])
        expect(entities.has(e)).toBe(true);
      await grant("quality", null);
      const hidden = await ok(await as(marcus.cookie).get("/sync?after=0&limit=1000"));
      expect(hidden.changes.some((c: { entity: string }) => c.entity.startsWith("quality_"))).toBe(false);
      await grant("quality", "write");
    });
  });

  describe("review fixes", () => {
    it("opens a non-conformance when a complaint's severity is raised later, once", async () => {
      const c = await ok(
        await as(ada).send("POST", "/quality/complaints", {
          receivedOn: today,
          source: "consumer",
          category: "foreign_body",
          description: "Hair in product",
        }),
        201,
      );
      expect(c.nonconformances).toEqual([]);
      const raised = await ok(
        await viaToken("PATCH", `/quality/complaints/${c.id}`, { severity: "critical" }),
      );
      expect(raised.nonconformances).toHaveLength(1);
      const again = await ok(
        await as(ada).send("PATCH", `/quality/complaints/${c.id}`, { severity: "major" }),
      );
      expect(again.nonconformances).toHaveLength(1);
    });

    it("takes the item from the lot when only the lot is given", async () => {
      const c = await ok(
        await as(ada).send("POST", "/quality/complaints", {
          receivedOn: today,
          source: "customer",
          category: "quality",
          lotId: cakeLot,
          description: "Dry",
        }),
        201,
      );
      expect(c.item).toMatchObject({ id: cake });
    });

    it("never gives API tokens a complainant's contact details", async () => {
      const c = await ok(
        await as(ada).send("POST", "/quality/complaints", {
          receivedOn: today,
          source: "consumer",
          category: "quality",
          description: "Stale",
          complainantContact: "jo@example.com",
        }),
        201,
      );
      expect(c.complainantContact).toBe("jo@example.com");
      expect((await ok(await viaToken("GET", `/quality/complaints/${c.id}`))).complainantContact).toBeNull();
      const list = await ok(await viaToken("GET", "/quality/complaints?q=Stale"));
      expect(list.complaints[0].complainantContact).toBeNull();
      const patched = await ok(
        await viaToken("PATCH", `/quality/complaints/${c.id}`, { investigation: "x" }),
      );
      expect(patched.complainantContact).toBeNull();
    });

    it("refuses a complaint or audit source without the link", async () => {
      const base = { raisedOn: today, title: "x", description: "x" };
      expect(
        (await as(ada).send("POST", "/quality/nonconformances", { ...base, source: "complaint" })).status,
      ).toBe(400);
      expect(
        (await as(ada).send("POST", "/quality/nonconformances", { ...base, source: "audit" })).status,
      ).toBe(400);
      expect(
        (
          await as(ada).send("POST", "/quality/nonconformances", {
            ...base,
            source: "process",
            dueOn: addDaysIso(today, -1),
          })
        ).status,
      ).toBe(400);
    });

    it("still edits a non-conformance whose owner has left, and clears action taken when reopened", async () => {
      const { members } = await (await ctx.req(`${WS}/members`, { cookie: ada })).json();
      const priya = members.find((m: { email: string }) => m.email === "priya@knotworking.dev").userId;
      const nc = await ok(
        await as(ada).send("POST", "/quality/nonconformances", {
          raisedOn: today,
          source: "process",
          title: "Label misprint",
          description: "Wrong date code",
          ownerUserId: priya,
          correctiveAction: "Reprinted",
        }),
        201,
      );
      await ok(await ctx.req(`${WS}/members/${priya}/deactivate`, { method: "POST", cookie: ada }));
      // The web sends the whole form, owner included.
      const edited = await ok(
        await as(ada).send("PATCH", `/quality/nonconformances/${nc.id}`, {
          ownerUserId: priya,
          rootCause: "Printer template",
          status: "action_taken",
        }),
      );
      expect(edited.actionTakenAt).toBeTruthy();
      // A new assignment to someone who has left is still refused.
      const other = await ok(
        await as(ada).send("POST", "/quality/nonconformances", {
          raisedOn: today,
          source: "process",
          title: "y",
          description: "y",
        }),
        201,
      );
      expect(
        (await as(ada).send("PATCH", `/quality/nonconformances/${other.id}`, { ownerUserId: priya })).status,
      ).toBe(400);
      const back = await ok(
        await as(ada).send("PATCH", `/quality/nonconformances/${nc.id}`, { status: "open" }),
      );
      expect(back.actionTakenAt).toBeNull();
      expect(
        (await as(ada).send("PATCH", `/quality/nonconformances/${nc.id}`, { dueOn: addDaysIso(today, -1) }))
          .status,
      ).toBe(400);
    });

    it("lets the member auditor or someone with manage sign off an audit", async () => {
      const plan = async (auditorUserId: string) =>
        (
          await ok(
            await as(ada).send("POST", "/quality/audits", {
              title: "Traceability",
              plannedOn: today,
              auditorUserId,
            }),
            201,
          )
        ).id;
      const body = { completedOn: today, summary: "Fine" };
      // Marcus has write on quality: he can sign off his own audit, not someone else's.
      const adaId = (await (await ctx.req("/v1/me", { cookie: ada })).json()).user.id;
      const adas = await plan(adaId);
      expect(await code(await as(marcus.cookie).send("POST", `/quality/audits/${adas}/complete`, body))).toBe(
        "not_auditor",
      );
      await ok(
        await as(marcus.cookie).send("POST", `/quality/audits/${await plan(marcus.userId)}/complete`, body),
      );
      // Ada heads quality (an owner has manage): she can sign off Marcus's audit.
      await ok(await as(ada).send("POST", `/quality/audits/${await plan(marcus.userId)}/complete`, body));
      // So can a member granted manage.
      await grant("quality", "manage");
      await ok(await as(marcus.cookie).send("POST", `/quality/audits/${adas}/complete`, body));
      await grant("quality", "write");
    });

    it("keeps the last passing recall test however many failures follow", async () => {
      const body = {
        conductedOn: today,
        lotId: cakeLot,
        startedAt: new Date(Date.now() - 61 * 60_000).toISOString(),
        completedAt: new Date(Date.now() - 60_000).toISOString(),
        quantityExpected: 480,
        quantityTraced: 479,
      };
      for (let i = 0; i < 11; i++) await ok(await as(ada).send("POST", "/quality/recall-tests", body), 201);
      const summary = await ok(await as(ada).get("/quality/summary"));
      expect(summary.recallTest.last.passed).toBe(false);
      expect(summary.recallTest).toMatchObject({ state: "ok", lastPassed: { passed: true } });
      // A unit mistake is a 400, not a database overflow.
      expect(
        (
          await as(ada).send("POST", "/quality/recall-tests", {
            ...body,
            quantityExpected: 0.001,
            quantityTraced: 100000,
          })
        ).status,
      ).toBe(400);
    });
  });
});
