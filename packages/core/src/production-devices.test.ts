import { describe, expect, it } from "vitest";
import {
  calibrationState,
  convertDeviceUnit,
  deviceCreateSchema,
  READING_CLOCK_SKEW_SECONDS,
  readingTiming,
} from "./production-devices";

describe("device units", () => {
  it("converts within a dimension and refuses across", () => {
    expect(convertDeviceUnit(0.402, "kg", "g")).toBe(402);
    expect(convertDeviceUnit(405, "g", "kg")).toBe(0.405);
    expect(convertDeviceUnit(1.5, "l", "ml")).toBe(1500);
    expect(convertDeviceUnit(4, "°C", "g")).toBeNull();
    expect(convertDeviceUnit(400, "g", "ml")).toBeNull();
  });

  it("requires a unit for measuring devices only", () => {
    expect(deviceCreateSchema.safeParse({ code: "S", name: "S", kind: "scale" }).success).toBe(false);
    expect(deviceCreateSchema.safeParse({ code: "M", name: "M", kind: "metal_detector" }).success).toBe(true);
  });
});

describe("calibration state", () => {
  it("comes from the latest calibration", () => {
    expect(calibrationState(false, null, "2026-11-16")).toBe("not_required");
    expect(calibrationState(true, null, "2026-11-16")).toBe("unknown");
    expect(calibrationState(true, { passed: false, nextDueOn: "2026-12-16" }, "2026-11-16")).toBe("failed");
    expect(calibrationState(true, { passed: true, nextDueOn: "2026-11-15" }, "2026-11-16")).toBe("overdue");
    expect(calibrationState(true, { passed: true, nextDueOn: "2026-11-16" }, "2026-11-16")).toBe("in_date");
    expect(calibrationState(true, { passed: true, nextDueOn: null }, "2026-11-16")).toBe("in_date");
  });
});

describe("reading timing", () => {
  const now = new Date("2026-11-16T12:00:00Z");
  it("accepts buffered readings as late, and refuses future and stale ones", () => {
    expect(readingTiming(new Date("2026-11-16T11:59:00Z"), now)).toEqual({ ok: true, late: false });
    expect(readingTiming(new Date("2026-11-16T09:00:00Z"), now)).toEqual({ ok: true, late: true });
    expect(readingTiming(new Date(now.getTime() + (READING_CLOCK_SKEW_SECONDS - 1) * 1000), now).ok).toBe(
      true,
    );
    expect(readingTiming(new Date("2026-11-16T13:00:00Z"), now).ok).toBe(false);
    expect(readingTiming(new Date("2026-10-01T12:00:00Z"), now).ok).toBe(false);
  });
});
