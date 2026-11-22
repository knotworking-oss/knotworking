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

describe("training tools", () => {
  it("lists active courses with the roles that need them", async () => {
    const { call } = await session();
    const res = await call("list_training_courses", { workspace: "acme" });
    expect(res.data.courses.map((c: { code: string }) => c.code)).toEqual(["HYG-01", "IND-01"]);
    expect(res.data.courses[0]).toMatchObject({
      kind: "sop",
      sop: { code: "SOP-HW", currentVersion: 2 },
      requiredBy: [{ jobRole: "Line operative", dueWithinDays: 7 }],
    });
    const all = await call("list_training_courses", { workspace: "acme", include_archived: true });
    expect(all.data.courses).toHaveLength(3);
  });

  it("reads the matrix by course code, and the due list", async () => {
    const { call, fake } = await session();
    const matrix = await call("get_training_matrix", {
      workspace: "acme",
      course: "hyg-01",
      job_role: "Line operative",
    });
    expect(matrix.data.staff[0]).toMatchObject({
      staffNumber: "100001",
      name: "Grace Hopper",
      courses: [{ course: "HYG-01", status: "missing", dueOn: "2026-01-12" }],
    });
    const query = fake.requests.filter((r: { path: string }) => r.path.endsWith("/training/matrix")).at(-1);
    expect(query).toBeTruthy();
    expect((await call("get_training_matrix", { workspace: "acme", course: "NOPE" })).data.error.code).toBe(
      "not_found",
    );
    const due = await call("list_training_due", { workspace: "acme" });
    expect(due.data.items).toEqual([
      expect.objectContaining({ name: "Grace Hopper", course: "HYG-01", status: "missing" }),
    ]);
  });

  it("records training by staff number, unsigned, and shows it in the person's history", async () => {
    const { call, fake } = await session();
    const res = await call("record_training", {
      workspace: "acme",
      course: "HYG-01",
      staff: ["100001", "000042"],
      completed_on: "2026-01-05",
      trainer: "Hygiene Training Ltd",
    });
    expect(res.data).toMatchObject({ course: "HYG-01", awaitingSignOff: true });
    expect(res.data.recorded.map((r: { staffNumber: string }) => r.staffNumber)).toEqual([
      "100001",
      "000042",
    ]);
    expect(fake.trainingModule.records).toHaveLength(2);
    const history = await call("get_staff_training", { workspace: "acme", staff: "100001" });
    expect(history.data.records).toEqual([
      expect.objectContaining({
        course: "HYG-01",
        trainer: "Hygiene Training Ltd",
        signedOff: null,
        voided: null,
      }),
    ]);
    expect(fake.requests.some((r: { path: string }) => r.path.endsWith("/sign-off"))).toBe(false);
  });

  it("refuses unknown people, duplicates and future dates", async () => {
    const { call } = await session();
    const base = { workspace: "acme", course: "IND-01", completed_on: "2026-01-05" };
    expect((await call("record_training", { ...base, staff: ["999999"] })).data.error.code).toBe("not_found");
    expect((await call("record_training", { ...base, staff: ["100001", "100001"] })).isError).toBe(true);
    expect(
      (await call("record_training", { ...base, staff: ["100001"], completed_on: "2026-02-01" })).isError,
    ).toBe(true);
  });
});
