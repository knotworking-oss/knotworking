import { describe, expect, it } from "vitest";
import { absenceCreateSchema, absenceCorrectSchema, workforceAvailabilitySchema } from "./workforce";
import { newId } from "./ids";
const command = () => ({
  commandId: newId(),
  kind: "annual_leave" as const,
  startOn: "2026-11-15",
  endOn: "2026-11-16",
  staffNote: "",
});
describe("workforce dates and privacy inputs", () => {
  it("accepts closed whole-day leave and ongoing sickness", () => {
    expect(absenceCreateSchema.parse(command()).endOn).toBe("2026-11-16");
    expect(absenceCreateSchema.parse({ ...command(), kind: "sickness", endOn: null }).endOn).toBeNull();
  });
  it.each([
    { endOn: null },
    { endOn: "2026-11-14" },
    { startOn: "2026-02-30" },
    { hrNote: "must not be accepted from self service" },
    { staffId: newId() },
  ])("rejects invalid ranges or privileged fields %#", (change) => {
    expect(absenceCreateSchema.safeParse({ ...command(), ...change }).success).toBe(false);
  });
  it("requires reviewed revisions and reasons for corrections", () => {
    expect(
      absenceCorrectSchema.safeParse({
        commandId: newId(),
        expectedRevision: 1,
        startOn: "2026-11-15",
        endOn: null,
        reason: "Return date not known",
      }).success,
    ).toBe(true);
    expect(
      absenceCorrectSchema.safeParse({
        commandId: newId(),
        expectedRevision: 1,
        startOn: "2026-11-15",
        endOn: "2026-11-14",
        reason: "wrong",
      }).success,
    ).toBe(false);
  });
  it("bounds planning queries and rejects invalid dates", () => {
    expect(workforceAvailabilitySchema.safeParse({ from: "2026-01-01", to: "2026-12-31" }).success).toBe(
      true,
    );
    for (const input of [
      { from: "2026-01-01", to: "2028-01-01" },
      { from: "2026-02-02", to: "2026-02-01" },
      { from: "invalid", to: "2026-01-01" },
    ])
      expect(workforceAvailabilitySchema.safeParse(input).success).toBe(false);
  });
});
