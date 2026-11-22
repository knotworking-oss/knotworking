import { describe, expect, it } from "vitest";
import { hseIncidentBodySchema } from "./hse";
import {
  hseDaysSince,
  hseIncidentActionState,
  hseInjuriesSaveSchema,
  hseReportSchema,
  hseYearAgo,
} from "./hse-incidents";

const injury = { personName: "Sam Lee", personType: "agency", nature: "Laceration", treatment: "first_aid" };
const reviewed = {
  commandId: "01a1d7e3-af9b-7054-b6c9-68fe4530020e",
  expectedRevision: 2,
  reason: "Found later",
};

describe("restricted incident follow-up rules", () => {
  it("ties the people hurt to an injury outcome", () => {
    expect(
      hseInjuriesSaveSchema.safeParse({ ...reviewed, injuries: [injury], outcome: "lost_time" }).success,
    ).toBe(true);
    expect(
      hseInjuriesSaveSchema.safeParse({ ...reviewed, injuries: [injury], outcome: "none" }).success,
    ).toBe(false);
    expect(hseInjuriesSaveSchema.safeParse({ ...reviewed, injuries: [], outcome: "first_aid" }).success).toBe(
      false,
    );
    expect(hseInjuriesSaveSchema.safeParse({ ...reviewed, injuries: [], outcome: "none" }).success).toBe(
      true,
    );
  });

  it("only lets reports be kinds in which nobody was hurt", () => {
    const report = { commandId: reviewed.commandId, occurredOn: "2026-11-10", place: "Yard", summary: "x" };
    expect(hseReportSchema.safeParse({ ...report, kind: "near_miss" }).success).toBe(true);
    expect(hseReportSchema.safeParse({ ...report, kind: "accident" }).success).toBe(false);
  });

  it("defaults the outcome on incidents recorded before it existed", () => {
    const body = hseIncidentBodySchema.parse({
      kind: "dangerous_occurrence",
      occurredOn: "2026-11-10",
      place: "Boiler house",
      summary: "Pressure relief valve lifted",
      immediateActions: "Boiler isolated",
      ownerUserId: reviewed.commandId,
    });
    expect(body.outcome).toBe("none");
  });

  it("works out overdue actions, a leap-day-safe year and days since lost time", () => {
    expect(hseIncidentActionState({ status: "open", dueOn: "2026-11-09" }, "2026-11-10")).toBe("overdue");
    expect(hseIncidentActionState({ status: "open", dueOn: "2026-11-10" }, "2026-11-10")).toBe("open");
    expect(hseIncidentActionState({ status: "cancelled", dueOn: "2026-11-01" }, "2026-11-10")).toBe(
      "cancelled",
    );
    expect(hseYearAgo("2024-02-29")).toBe("2023-02-28");
    expect(hseYearAgo("2026-11-15")).toBe("2025-11-15");
    expect(hseDaysSince(null, "2026-11-10")).toBeNull();
    expect(hseDaysSince("2026-10-31", "2026-11-10")).toBe(10);
  });
});
