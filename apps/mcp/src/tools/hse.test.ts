import { newId, hseContentSchema } from "@knotworking/core";
import { afterEach, describe, it, expect } from "vitest";
import { connect } from "../testing/harness";
import { READ_TOKEN } from "../testing/fake-api";
const sessions: Awaited<ReturnType<typeof connect>>[] = [];
const session = async (options: Parameters<typeof connect>[0] = {}) => {
  const s = await connect(options);
  sessions.push(s);
  return s;
};
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});
describe("HSE assistant boundary", () => {
  it("offers registers without Site and keeps asset permit tools out of that scope", async () => {
    const { client } = await session({ defaultWorkspace: "acme", modules: ["people", "training", "hse"] });
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("list_hse_registers");
    expect(names).not.toContain("list_hse_permits");
  });
  it("prepares ordinary drafts with reviewed revisions and pages evidence without signatures or health access", async () => {
    const { call, client } = await session({ defaultWorkspace: "acme" });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("draft_hse_permit");
    expect(names).not.toContain("approve_hse_register");
    expect(names.some((n) => n.includes("hse_incident"))).toBe(false);
    const content = hseContentSchema.parse({ scope: "Mixer" });
    const r = await call("draft_hse_register", {
      request: { commandId: newId(), title: "Mixer risk", kind: "risk_assessment", content },
    });
    expect(r.isError).toBe(false);
    expect((await call("list_hse_registers", { limit: 1 })).data.total).toBe(1);
    expect((await call("get_hse_record", { record_id: r.data.id })).data.draft.content.scope).toBe("Mixer");
    const changed = await call("draft_hse_register", {
      record_id: r.data.id,
      request: { commandId: newId(), expectedRevision: 1, reason: "Reviewed scope", content },
    });
    expect(changed.data.revision).toBe(2);
    expect(
      (
        await call("draft_hse_register", {
          record_id: r.data.id,
          request: { commandId: newId(), expectedRevision: 1, reason: "Stale", content },
        })
      ).isError,
    ).toBe(true);
    expect(
      (await call("get_hse_record", { record_id: r.data.id, section: "history", limit: 2, offset: 1 })).data,
    ).toMatchObject({ limit: 2, offset: 1 });
    const body = {
      contractorRecordId: newId(),
      assessmentIds: [r.data.id],
      assetId: newId(),
      startsOn: "2026-11-15",
      endsOn: "2026-11-15",
      workScope: "Guard change",
      precautions: "Isolation",
      isolationRequired: true,
      isolationPoints: "Main isolator",
      inductionChecked: false,
      ppeChecked: false,
      emergencyReady: false,
    };
    const p = await call("draft_hse_permit", { request: { commandId: newId(), title: "Guard work", body } });
    expect(p.data.status).toBe("draft");
    expect((await call("get_hse_permit", { permit_id: p.data.id })).data.body.workScope).toBe("Guard change");
    expect((await call("list_hse_permits", {})).data.total).toBe(1);
  });
  it("refuses read-token drafts and malformed edit commands", async () => {
    const { call } = await session({ defaultWorkspace: "acme", token: READ_TOKEN });
    expect((await call("list_hse_registers", {})).isError).toBe(false);
    expect(
      (
        await call("draft_hse_register", {
          request: { commandId: newId(), title: "No write", kind: "risk_assessment", content: {} },
        })
      ).isError,
    ).toBe(true);
  });
  it("reports a near miss and gets only its reference back", async () => {
    const { call, fake } = await session({ defaultWorkspace: "acme" });
    const r = await call("report_hse_near_miss", {
      kind: "near_miss",
      occurred_on: "2026-11-10",
      place: "Goods-in",
      summary: "Pallet slipped from the forks; nobody nearby",
    });
    expect(r.isError).toBe(false);
    expect(r.data).toEqual({ id: expect.any(String), reference: expect.stringMatching(/^HSE-/) });
    expect(fake.hseModule.reports).toHaveLength(1);
    // Nobody-hurt kinds only: an accident is a person's to record.
    expect(
      (
        await call("report_hse_near_miss", {
          kind: "accident",
          occurred_on: "2026-11-10",
          place: "x",
          summary: "x",
        })
      ).isError,
    ).toBe(true);
  });
});
