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

describe("attendance tools", () => {
  it("reports shifts in hours, with issues", async () => {
    const { call } = await session();
    const res = await call("get_attendance_shifts", {
      workspace: "acme",
      from: "2026-03-01",
      to: "2026-03-08",
    });
    expect(res.data.people[0]).toMatchObject({
      name: "Grace Hopper",
      paidHours: 8,
      basicHours: 7.5,
      overtimeHours: 0.5,
      shifts: [{ date: "2026-03-02", paidHours: 8, issue: null }],
    });
    const issues = await call("get_attendance_shifts", {
      workspace: "acme",
      from: "2026-03-01",
      to: "2026-03-08",
      issues_only: true,
    });
    expect(issues.data.people.map((p: { name: string }) => p.name)).toEqual(["Alan Turing"]);
    expect(
      (await call("get_attendance_shifts", { workspace: "acme", from: "2026-03-08", to: "2026-03-01" }))
        .isError,
    ).toBe(true);
  });

  it("lists who is on site, and who may have left without clocking out", async () => {
    const { call } = await session();
    const res = await call("who_is_on_site", { workspace: "acme" });
    expect(res.data).toMatchObject({
      staff: [{ staffNumber: "100001", name: "Grace Hopper" }],
      visitors: [{ name: "Mary Somerville" }],
      possiblyLeft: { staff: [{ name: "Alan Turing" }], visitors: [] },
    });
  });
});
