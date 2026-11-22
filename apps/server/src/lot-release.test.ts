import { DEFAULT_TIME_ZONE, todayInZone } from "@knotworking/core";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";
const today = todayInZone(DEFAULT_TIME_ZONE);

describe("evidence-based lot release", () => {
  let ctx: TestCtx;
  let ada: string;
  let marcus: { cookie: string; userId: string };
  let token: string;
  const as = (cookie: string) => ({
    get: (path: string) => ctx.req(`${WS}${path}`, { cookie }),
    send: (method: string, path: string, json?: unknown) => ctx.req(`${WS}${path}`, { method, cookie, json }),
  });
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
  const grant = async (moduleId: string, level: string | null) =>
    ok(
      await ctx.req(`${WS}/members/${marcus.userId}/module-access/${moduleId}`, {
        method: "PUT",
        cookie: ada,
        json: { level },
      }),
    );

  let flour: string;
  let store: string;
  const receive = async () =>
    (
      await ok(
        await as(ada).send("POST", "/stock/receipts", {
          itemId: flour,
          quantity: 10,
          unit: "kg",
          locationId: store,
          receivedOn: today,
        }),
        201,
      )
    ).id as string;
  const hold = (lot: string) =>
    as(ada).send("POST", `/stock/lots/${lot}/status`, { status: "quarantine", note: "Hold" });
  const release = (lot: string, extra: Record<string, unknown> = {}, cookie = ada) =>
    as(cookie).send("POST", `/stock/lots/${lot}/status`, { status: "available", note: "Released", ...extra });
  const sample = async (lot: string, analytes: { name: string; max?: number; limitText?: string }[]) =>
    ok(
      await as(ada).send("POST", "/testing/samples", {
        subject: "lot",
        lotId: lot,
        sampledOn: today,
        analytes: analytes.map((a) => ({ category: "microbiological", ...a })),
      }),
      201,
    );
  const record = async (s: any, values: Record<string, { value?: number; outcome?: "pass" | "fail" }>) =>
    ok(
      await as(ada).send("POST", `/testing/samples/${s.id}/results`, {
        reportedOn: today,
        results: s.results.map((r: any) => ({ resultId: r.id, ...values[r.name] })),
      }),
    );

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
    flour = (
      await ok(
        await as(ada).send("POST", "/items", { code: "FLR", name: "Flour", type: "ingredient", unit: "kg" }),
        201,
      )
    ).id;
    store = (await ok(await as(ada).send("POST", "/stock/locations", { name: "Dry store" }), 201)).id;
  });

  afterAll(() => ctx.handle.close());

  it("releases a held lot with nothing against it and records the checks", async () => {
    const lot = await receive();
    await ok(await hold(lot));
    const check = await ok(await as(ada).get(`/stock/lots/${lot}/release-check`));
    expect(check).toMatchObject({ blocked: false, ruleVersion: null, rule: null });
    expect(check.checks.map((c: { kind: string; status: string }) => [c.kind, c.status])).toEqual([
      ["tests_pending", "pass"],
      ["investigation_open", "pass"],
      ["test_failed", "pass"],
      ["packing_checks", "info"],
    ]);
    await ok(await release(lot));
    const { releases } = await ok(await as(ada).get(`/stock/lots/${lot}/releases`));
    expect(releases).toHaveLength(1);
    expect(releases[0]).toMatchObject({
      fromStatus: "quarantine",
      exception: false,
      note: "Released",
      ruleVersion: null,
    });
    expect(releases[0].releasedByName).toBeTruthy();
  });

  it("blocks a release while results are pending, unless two managers agree an exception", async () => {
    const lot = await receive();
    await ok(await hold(lot));
    const s = await sample(lot, [{ name: "Salmonella", limitText: "Absent in 25 g" }]);
    const blocked = await fails(await release(lot), 409, "release_blocked");
    expect(blocked.error.message).toContain("awaiting results");
    expect(
      blocked.error.details.checks.find((c: { kind: string }) => c.kind === "tests_pending"),
    ).toMatchObject({
      status: "block",
      refs: [{ label: s.reference }],
    });
    // Tokens never release; the old one-step exception no longer releases anything.
    expect(
      (
        await ctx.req(`${WS}/stock/lots/${lot}/status`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, origin: "" },
          json: { status: "available", note: "x" },
        })
      ).status,
    ).toBe(403);
    await fails(
      await release(lot, { exception: { reason: "Customer waiver", evidence: "Email" } }),
      409,
      "release_blocked",
    );
    const path = `/stock/lots/${lot}/release-exceptions`;
    const exception = {
      note: "Positive release",
      reason: "Customer accepted on positive release",
      evidence: "Email from QA lead, ref W-12",
    };
    // A request needs a reason and evidence, and a person with stock manage.
    await fails(await as(ada).send("POST", path, { note: "x", reason: "Customer waiver" }), 400);
    await grant("items", "read");
    await grant("stock", "write");
    expect((await as(marcus.cookie).send("POST", path, exception)).status).toBe(403);
    await grant("stock", "manage");
    const { requests } = await ok(await as(ada).send("POST", path, exception), 201);
    expect(requests[0]).toMatchObject({
      status: "pending",
      ...exception,
      requestedByName: expect.any(String),
    });
    await fails(await as(ada).send("POST", path, exception), 409, "exception_pending");
    // Still blocked; the requester can't approve their own while another manager exists.
    expect((await ok(await as(ada).get(`/stock/lots/${lot}`))).status).toBe("quarantine");
    await fails(await as(ada).send("POST", `${path}/${requests[0].id}/approve`, {}), 403, "four_eyes");
    // Marcus approves: the lot is released, recording both people.
    const released = await ok(
      await as(marcus.cookie).send("POST", `${path}/${requests[0].id}/approve`, { note: "Agreed" }),
    );
    expect(released.status).toBe("available");
    const { releases } = await ok(await as(ada).get(`/stock/lots/${lot}/releases`));
    expect(releases[0]).toMatchObject({
      exception: true,
      exceptionReason: "Customer accepted on positive release",
      exceptionEvidence: "Email from QA lead, ref W-12",
      exceptionRequestId: requests[0].id,
      exceptionRequestedBy: expect.any(String),
      exceptionRequestedByName: expect.any(String),
      exceptionSelfApproved: false,
    });
    expect(releases[0].releasedByName).not.toBe(releases[0].exceptionRequestedByName);
    expect(releases[0].checks.find((c: { kind: string }) => c.kind === "tests_pending").status).toBe("block");
    const after = await ok(await as(ada).get(path));
    expect(after.requests[0]).toMatchObject({ status: "approved", decisionNote: "Agreed" });
    await fails(
      await as(marcus.cookie).send("POST", `${path}/${requests[0].id}/approve`, {}),
      409,
      "exception_not_pending",
    );
  });

  it("refuses an exception approval against blockers it wasn't requested for, and lets requests be rejected", async () => {
    await grant("stock", "manage");
    const lot = await receive();
    await ok(await hold(lot));
    const path = `/stock/lots/${lot}/release-exceptions`;
    const exception = { note: "Release", reason: "Agreed with customer", evidence: "Ref 7" };
    // Nothing blocks: no exception is needed.
    await fails(await as(ada).send("POST", path, exception), 409, "exception_not_needed");
    const pendingSample = await sample(lot, [{ name: "Moisture", max: 15 }]);
    let { requests } = await ok(await as(ada).send("POST", path, exception), 201);
    expect(requests[0].checks.find((c: { kind: string }) => c.kind === "tests_pending").status).toBe("block");
    // The result comes back failed after the request: approving would cover a failure nobody asked about.
    await record(pendingSample, { Moisture: { value: 18 } });
    await fails(
      await as(marcus.cookie).send("POST", `${path}/${requests[0].id}/approve`, {}),
      409,
      "exception_stale",
    );
    expect((await ok(await as(ada).get(path))).requests[0].status).toBe("superseded");
    expect((await ok(await as(ada).get(`/stock/lots/${lot}`))).status).toBe("quarantine");
    // A new request can be rejected by another manager, or withdrawn by its requester.
    ({ requests } = await ok(await as(ada).send("POST", path, exception), 201));
    await fails(await as(marcus.cookie).send("POST", `${path}/${requests[0].id}/reject`, {}), 400);
    ({ requests } = await ok(
      await as(marcus.cookie).send("POST", `${path}/${requests[0].id}/reject`, {
        note: "Wait for the result",
      }),
    ));
    expect(requests[0]).toMatchObject({ status: "rejected", decisionNote: "Wait for the result" });
    ({ requests } = await ok(await as(ada).send("POST", path, exception), 201));
    ({ requests } = await ok(
      await as(ada).send("POST", `${path}/${requests[0].id}/reject`, { note: "Raised in error" }),
    ));
    expect(requests[0].status).toBe("withdrawn");
    // Tokens can read requests but never make or decide them.
    const viaToken = (method: string, url: string, json?: unknown) =>
      ctx.req(`${WS}${url}`, { method, headers: { authorization: `Bearer ${token}`, origin: "" }, json });
    expect((await viaToken("GET", path)).status).toBe(200);
    expect((await viaToken("POST", path, exception)).status).toBe(403);
  });

  it("never approves an exception for a lot whose status changed since the request", async () => {
    await grant("items", "read");
    await grant("stock", "manage");
    const lot = await receive();
    await ok(await hold(lot));
    await sample(lot, [{ name: "Moisture", max: 15 }]);
    const path = `/stock/lots/${lot}/release-exceptions`;
    const exception = { note: "Release", reason: "Agreed with customer", evidence: "Ref 11" };
    let { requests } = await ok(await as(ada).send("POST", path, exception), 201);
    // Ada rejects the lot after asking: the request is closed, and approving it can't release the lot.
    await ok(
      await as(ada).send("POST", `/stock/lots/${lot}/status`, { status: "rejected", note: "Contaminated" }),
    );
    expect((await ok(await as(ada).get(path))).requests[0]).toMatchObject({
      status: "superseded",
      decisionNote: expect.stringContaining("rejected"),
    });
    await fails(
      await as(marcus.cookie).send("POST", `${path}/${requests[0].id}/approve`, {}),
      409,
      "exception_not_pending",
    );
    expect((await ok(await as(ada).get(`/stock/lots/${lot}`))).status).toBe("rejected");
    // Even if a pending request outlived a status change (the backstop), approval refuses it.
    ({ requests } = await ok(await as(ada).send("POST", path, exception), 201));
    await ctx.handle.db.execute(
      sql`update stock_lots set status = 'quarantine', status_changed_at = now() + interval '1 second' where id = ${lot}`,
    );
    await fails(
      await as(marcus.cookie).send("POST", `${path}/${requests[0].id}/approve`, {}),
      409,
      "exception_stale",
    );
    expect((await ok(await as(ada).get(`/stock/lots/${lot}`))).status).toBe("quarantine");
  });

  it("refuses an approval when a new record appears under a blocker kind already shown", async () => {
    const lot = await receive();
    await ok(await hold(lot));
    const first = await sample(lot, [{ name: "Moisture", max: 15 }]);
    await record(first, { Moisture: { value: 18 } });
    const path = `/stock/lots/${lot}/release-exceptions`;
    const { requests } = await ok(
      await as(ada).send("POST", path, {
        note: "Release",
        reason: "Moisture within customer tolerance",
        evidence: "Ref 12",
      }),
      201,
    );
    // A second, different failure of the same kind arrives: nobody was shown it.
    const second = await sample(lot, [{ name: "Salmonella", limitText: "Absent in 25 g" }]);
    await record(second, { Salmonella: { outcome: "fail" } });
    await fails(
      await as(marcus.cookie).send("POST", `${path}/${requests[0].id}/approve`, {}),
      409,
      "exception_stale",
    );
    expect((await ok(await as(ada).get(`/stock/lots/${lot}`))).status).toBe("quarantine");
    const after = await ok(await as(ada).get(path));
    expect(after.requests[0].status).toBe("superseded");
  });

  it("lets the only stock manager approve their own exception, and says so", async () => {
    await grant("stock", "write");
    const lot = await receive();
    await ok(await hold(lot));
    await sample(lot, [{ name: "Moisture", max: 15 }]);
    const path = `/stock/lots/${lot}/release-exceptions`;
    const { requests } = await ok(
      await as(ada).send("POST", path, { note: "Release", reason: "Agreed", evidence: "Ref 9" }),
      201,
    );
    // Marcus is down to write, so Ada is the only stock manager: she may approve her own.
    const released = await ok(await as(ada).send("POST", `${path}/${requests[0].id}/approve`, {}));
    expect(released.status).toBe("available");
    const { releases } = await ok(await as(ada).get(`/stock/lots/${lot}/releases`));
    expect(releases[0]).toMatchObject({ exception: true, exceptionSelfApproved: true });
    await grant("stock", "manage");
  });

  it("keeps a failed lot from release until its investigation is closed and a retest passes", async () => {
    const lot = await receive();
    const first = await sample(lot, [{ name: "Moisture", max: 15 }]);
    const failed = await record(first, { Moisture: { value: 16 } });
    expect(failed.lot.status).toBe("quarantine");
    let body = await fails(await release(lot), 409, "release_blocked");
    expect(
      body.error.details.checks.find((c: { kind: string }) => c.kind === "investigation_open").status,
    ).toBe("block");
    await ok(
      await as(ada).send("POST", `/testing/samples/${first.id}/investigation/close`, {
        findings: "Damp store",
        actionTaken: "Moved and retested",
      }),
    );
    body = await fails(await release(lot), 409, "release_blocked");
    expect(body.error.details.checks.find((c: { kind: string }) => c.kind === "test_failed")).toMatchObject({
      status: "block",
      refs: [{ label: first.reference }],
    });
    const retest = await sample(lot, [{ name: "Moisture", max: 15 }]);
    await record(retest, { Moisture: { value: 14.1 } });
    const check = await ok(await as(ada).get(`/stock/lots/${lot}/release-check`));
    expect(check.blocked).toBe(false);
    expect(check.checks.find((c: { kind: string }) => c.kind === "test_failed").detail).toContain(
      "passed a retest",
    );
    await ok(await release(lot));
  });

  it("applies the item's versioned release rule, changed only by a person with manage", async () => {
    const rule = {
      requirePassingTest: true,
      requiredAnalytes: ["Salmonella"],
      requireApprovedSpecification: true,
    };
    await fails(
      await as(ada).send("PUT", `/stock/release-rules/${flour}`, { requiredAnalytes: ["Salmonella"] }),
      400,
    );
    expect(
      (
        await ctx.req(`${WS}/stock/release-rules/${flour}`, {
          method: "PUT",
          headers: { authorization: `Bearer ${token}`, origin: "" },
          json: rule,
        })
      ).status,
    ).toBe(403);
    await grant("stock", "write");
    expect((await as(marcus.cookie).send("PUT", `/stock/release-rules/${flour}`, rule)).status).toBe(403);
    const v1 = await ok(await as(ada).send("PUT", `/stock/release-rules/${flour}`, rule));
    expect(v1).toMatchObject({ version: 1, requirePassingTest: true, item: { code: "FLR" } });

    const lot = await receive();
    await ok(await hold(lot));
    let check = await ok(await as(ada).get(`/stock/lots/${lot}/release-check`));
    expect(check.ruleVersion).toBe(1);
    expect(
      check.checks
        .filter((c: { fromRule: boolean }) => c.fromRule)
        .map((c: { kind: string; status: string }) => [c.kind, c.status]),
    ).toEqual([
      ["required_test", "block"],
      ["specification", "block"],
    ]);
    // A passing sample without the required analyte doesn't count.
    await record(await sample(lot, [{ name: "Moisture", max: 15 }]), { Moisture: { value: 12 } });
    check = await ok(await as(ada).get(`/stock/lots/${lot}/release-check`));
    expect(check.checks.find((c: { kind: string }) => c.kind === "required_test").status).toBe("block");
    await record(await sample(lot, [{ name: "salmonella", limitText: "Absent in 25 g" }]), {
      salmonella: { outcome: "pass" },
    });
    check = await ok(await as(ada).get(`/stock/lots/${lot}/release-check`));
    expect(check.checks.find((c: { kind: string }) => c.kind === "required_test").status).toBe("pass");

    // Drop the specification requirement: version 2, and the release records it.
    const v2 = await ok(
      await as(ada).send("PUT", `/stock/release-rules/${flour}`, {
        ...rule,
        requireApprovedSpecification: false,
        note: "Low risk",
      }),
    );
    expect(v2.version).toBe(2);
    await ok(await release(lot));
    const { releases } = await ok(await as(ada).get(`/stock/lots/${lot}/releases`));
    expect(releases[0]).toMatchObject({
      ruleVersion: 2,
      exception: false,
      rule: { version: 2, note: "Low risk" },
    });
    const { rules } = await ok(await as(ada).get("/stock/release-rules"));
    expect(rules).toHaveLength(1);
  });

  it("checks a CCP review rule, and hides references from readers who can't see the module", async () => {
    await ok(await as(ada).send("PUT", `/stock/release-rules/${flour}`, { requireCcpReviewed: true }));
    const lot = await receive();
    await ok(await hold(lot));
    const s = await sample(lot, [{ name: "Moisture", max: 15 }]);
    const check = await ok(await as(ada).get(`/stock/lots/${lot}/release-check`));
    // Not made in a batch: nothing to review.
    expect(check.checks.find((c: { kind: string }) => c.kind === "ccp_review")).toMatchObject({
      status: "info",
    });
    // Marcus can read stock but not testing: the pending test still blocks, without its reference.
    await grant("items", "read");
    const theirs = await ok(await as(marcus.cookie).get(`/stock/lots/${lot}/release-check`));
    expect(theirs.blocked).toBe(true);
    expect(theirs.checks.find((c: { kind: string }) => c.kind === "tests_pending")).toMatchObject({
      status: "block",
      hidden: true,
      refs: [],
    });
    await record(s, { Moisture: { value: 10 } });
    await ok(await release(lot));
    expect((await as(ada).send("DELETE", `/stock/release-rules/${flour}`)).status).toBe(204);
    expect((await ok(await as(ada).get("/stock/release-rules"))).rules).toEqual([]);
  });
});
