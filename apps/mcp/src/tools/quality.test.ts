import { newId } from "@knotworking/core";
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

describe("quality tools", () => {
  it("offers no sign-off tools", async () => {
    const { client } = await session();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "get_quality_summary",
        "list_complaints",
        "list_nonconformances",
        "list_quality_audits",
        "get_quality_record",
        "log_complaint",
        "update_complaint",
        "raise_nonconformance",
        "update_nonconformance",
        "plan_quality_audit",
      ]),
    );
    expect(names.some((n) => /close|verify|complete_audit|recall_test/.test(n))).toBe(false);
  });

  it("logs a complaint by item code and lot code, opening a non-conformance for a major food-safety one", async () => {
    const { call, fake } = await session();
    const flour = fake.itemsModule.items.find((i) => i.code === "FLR-001")!;
    fake.stockModule.lots.push({ id: newId(), itemId: flour.id, lotCode: "L-77" });
    const res = await call("log_complaint", {
      workspace: "acme",
      received_on: "2026-01-05",
      source: "retailer",
      category: "foreign_body",
      severity: "major",
      description: "Plastic in bag",
      item: "flr-001",
      lot: "l-77",
      complainant_contact: "buyer@example.com",
    });
    expect(res.data).toMatchObject({
      reference: "CMP-2026-001",
      item: expect.stringContaining("FLR-001"),
      lot: "L-77",
      nonconformancesOpened: [{ reference: "NC-2026-001", severity: "major" }],
    });
    expect(JSON.stringify(res.data)).not.toContain("buyer@example.com");
    const complaint = fake.qualityModule.complaints[0]!;
    expect(complaint.complainantContact).toBe("buyer@example.com");

    const unknown = await call("log_complaint", {
      workspace: "acme",
      received_on: "2026-01-05",
      source: "consumer",
      category: "quality",
      description: "x",
      lot: "NOPE",
    });
    expect(unknown.data.error.code).toBe("not_found");
  });

  it("finds records by reference and updates them", async () => {
    const { call } = await session();
    await call("log_complaint", {
      workspace: "acme",
      received_on: "2026-01-05",
      source: "consumer",
      category: "quality",
      description: "Too salty",
    });
    const updated = await call("update_complaint", {
      workspace: "acme",
      reference: "cmp-2026-001",
      status: "investigating",
      investigation: "Checked the batch record",
    });
    expect(updated.data).toMatchObject({
      status: "investigating",
      investigation: "Checked the batch record",
    });
    const record = await call("get_quality_record", { workspace: "acme", reference: "CMP-2026-001" });
    expect(record.data).toMatchObject({ kind: "complaint", description: "Too salty", nonconformances: [] });
    expect((await call("get_quality_record", { workspace: "acme", reference: "XX-1" })).data.error.code).toBe(
      "not_found",
    );
    expect(
      (await call("update_nonconformance", { workspace: "acme", reference: "CMP-2026-001", root_cause: "x" }))
        .data.error.code,
    ).toBe("invalid_input");
  });

  it("raises a non-conformance and marks the action taken", async () => {
    const { call } = await session();
    const nc = await call("raise_nonconformance", {
      workspace: "acme",
      raised_on: "2026-01-05",
      source: "process",
      severity: "critical",
      title: "Metal detector failed check",
      description: "Line 1 missed the 2.0 mm test piece",
    });
    expect(nc.data).toMatchObject({ reference: "NC-2026-001", dueOn: "2026-01-12", status: "open" });
    const refused = await call("update_nonconformance", {
      workspace: "acme",
      reference: "NC-2026-001",
      status: "action_taken",
    });
    expect(refused.data.error).toBeTruthy();
    const taken = await call("update_nonconformance", {
      workspace: "acme",
      reference: "NC-2026-001",
      status: "action_taken",
      corrective_action: "Detector serviced and re-validated",
    });
    expect(taken.data).toMatchObject({
      status: "action_taken",
      correctiveAction: "Detector serviced and re-validated",
    });
    const missing = await call("raise_nonconformance", {
      workspace: "acme",
      raised_on: "2026-01-05",
      source: "complaint",
      title: "x",
      description: "x",
    });
    expect(missing.data.error.code).toBe("invalid_input");
  });

  it("plans an audit and reads the summary", async () => {
    const { call } = await session();
    const audit = await call("plan_quality_audit", {
      workspace: "acme",
      title: "Traceability",
      planned_on: "2026-01-12",
      auditor: "Q. Lead",
    });
    expect(audit.data).toMatchObject({ reference: "IA-2026-001", state: "soon" });
    const list = await call("list_quality_audits", { workspace: "acme" });
    expect(list.data.audits[0]).toMatchObject({ title: "Traceability", auditor: "Q. Lead" });
    const summary = await call("get_quality_summary", { workspace: "acme" });
    expect(summary.data).toMatchObject({ recallTest: { state: "never" }, recentRecallTests: [] });
  });
});
