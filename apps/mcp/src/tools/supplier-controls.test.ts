import { afterEach, describe, expect, it } from "vitest";
import { connect } from "../testing/harness";

type Session = Awaited<ReturnType<typeof connect>>;
const open: Session[] = [];
async function session() {
  const s = await connect();
  open.push(s);
  return s;
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

describe("supplier control tools", () => {
  it("lists compliance issues and a supplier's controls", async () => {
    const { call } = await session();
    const list = await call("list_supplier_compliance", { workspace: "acme", only_issues: true });
    expect(list.data.suppliers[0]).toMatchObject({ name: "Shipton Mill", actions: 1 });
    expect(list.data.suppliers[0].issues[0]).toMatch(/^ACTION: No risk assessment/);
    expect(list.data.note).toMatch(/no tools/);
    const controls = await call("get_supplier_controls", { workspace: "acme", supplier: "ship" });
    expect(controls.data).toMatchObject({ riskLevel: null, assessments: [], questionnaires: [] });
  });

  it("logs a questionnaire and marks it received", async () => {
    const { call } = await session();
    const sent = await call("log_supplier_questionnaire", {
      workspace: "acme",
      supplier: "Shipton Mill",
      title: "Annual SAQ",
      sent_on: "2026-01-02",
    });
    expect(sent.data).toMatchObject({ status: "sent", title: "Annual SAQ" });
    const back = await call("log_supplier_questionnaire", {
      workspace: "acme",
      supplier: "SHIP",
      questionnaire: sent.data.id,
      received_on: "2026-01-04",
    });
    expect(back.data).toMatchObject({ status: "received", receivedOn: "2026-01-04" });
    const missing = await call("log_supplier_questionnaire", { workspace: "acme", supplier: "SHIP" });
    expect(missing.isError).toBe(true);
  });
});
