import { describe, expect, it } from "vitest";
import { computeOee, downtimeCategory, downtimeReasons, downtimeReasonInfo } from "./production-performance";

describe("OEE", () => {
  it("multiplies out to ideal good time over planned production time", () => {
    const r = computeOee({
      capacityMinutes: 480,
      plannedDowntimeMinutes: 30,
      unplannedDowntimeMinutes: 60,
      batches: [{ good: 30, rejects: 6, ratePerHour: 10 }],
    });
    expect(r).toMatchObject({
      plannedProductionMinutes: 450,
      runMinutes: 390,
      availability: 0.8667,
      quality: 0.8333,
    });
    expect(r.oee).toBeCloseTo(r.availability! * r.performance! * r.quality!, 3);
    expect(r.oee).toBe(0.4);
  });

  it("leaves unrated batches out and says so, and flags impossible inputs", () => {
    const r = computeOee({
      capacityMinutes: 60,
      plannedDowntimeMinutes: 0,
      unplannedDowntimeMinutes: 90,
      batches: [
        { good: 10, rejects: 0, ratePerHour: null },
        { good: 0, rejects: 0, ratePerHour: null },
      ],
    });
    expect(r.unratedBatches).toBe(1);
    expect(r.runMinutes).toBe(0);
    expect(r.performance).toBeNull();
    expect(r.warnings.join(" ")).toMatch(/no rate/);
    expect(r.warnings.join(" ")).toMatch(/more than the planned production time/);
    const off = computeOee({
      capacityMinutes: 0,
      plannedDowntimeMinutes: 0,
      unplannedDowntimeMinutes: 0,
      batches: [{ good: 5, rejects: 0, ratePerHour: 10 }],
    });
    expect(off.oee).toBeNull();
    expect(off.warnings.join(" ")).toMatch(/no capacity/);
    const fast = computeOee({
      capacityMinutes: 60,
      plannedDowntimeMinutes: 0,
      unplannedDowntimeMinutes: 0,
      batches: [{ good: 20, rejects: 0, ratePerHour: 10 }],
    });
    expect(fast.performance).toBe(2);
    expect(fast.warnings.join(" ")).toMatch(/rate .* too low/);
  });

  it("classes every downtime reason as planned or unplanned", () => {
    for (const r of downtimeReasons)
      expect(["planned", "unplanned"]).toContain(downtimeReasonInfo[r].category);
    expect(downtimeCategory("breakdown")).toBe("unplanned");
    expect(downtimeCategory("changeover")).toBe("planned");
  });
});
