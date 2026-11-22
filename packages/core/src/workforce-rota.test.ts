import { describe, expect, it } from "vitest";
import { newId } from "./ids";
import {
  ALL_WEEKDAYS,
  WEEKDAYS_MON_FRI,
  datesBetween,
  isoWeekday,
  onWeekday,
  rotaGenerateSchema,
  rotaQuerySchema,
  shiftCreateSchema,
  shiftMinutes,
  shiftWindow,
  staffingRequirementCreateSchema,
  weekdayLabel,
  windowsOverlap,
  workingPatternCreateSchema,
} from "./workforce-rota";

describe("rota helpers", () => {
  it("numbers weekdays from Monday and reads masks", () => {
    expect(isoWeekday("2026-11-16")).toBe(0); // Monday
    expect(isoWeekday("2026-11-22")).toBe(6); // Sunday
    expect(onWeekday(WEEKDAYS_MON_FRI, "2026-11-20")).toBe(true);
    expect(onWeekday(WEEKDAYS_MON_FRI, "2026-11-21")).toBe(false);
    expect(weekdayLabel(ALL_WEEKDAYS)).toBe("Every day");
    expect(weekdayLabel(0b1000001)).toBe("Mon, Sun");
  });
  it("treats a shift that ends at or before its start as crossing midnight", () => {
    const night = { startTime: "22:00", endTime: "06:00" };
    const early = { startTime: "06:00", endTime: "14:00" };
    expect(shiftMinutes(night)).toBe(480);
    // Monday's night shift overlaps Tuesday 05:00–13:00 but not Tuesday's early shift.
    expect(windowsOverlap(shiftWindow("2026-11-16", night), shiftWindow("2026-11-17", early))).toBe(false);
    expect(
      windowsOverlap(
        shiftWindow("2026-11-16", night),
        shiftWindow("2026-11-17", { startTime: "05:00", endTime: "13:00" }),
      ),
    ).toBe(true);
    expect(windowsOverlap(shiftWindow("2026-11-16", early), shiftWindow("2026-11-16", night))).toBe(false);
  });
  it("lists inclusive date ranges", () => {
    expect(datesBetween("2026-12-30", "2027-01-02")).toEqual([
      "2026-12-30",
      "2026-12-31",
      "2027-01-01",
      "2027-01-02",
    ]);
  });
});

describe("rota schemas", () => {
  it("validates times, windows and requirement shape", () => {
    expect(
      shiftCreateSchema.safeParse({ commandId: newId(), name: "Early", startTime: "6:00", endTime: "14:00" })
        .success,
    ).toBe(false);
    expect(
      shiftCreateSchema.safeParse({ commandId: newId(), name: "X", startTime: "06:00", endTime: "06:00" })
        .success,
    ).toBe(false);
    expect(rotaQuerySchema.safeParse({ from: "2026-11-01", to: "2026-12-01" }).success).toBe(true);
    expect(rotaQuerySchema.safeParse({ from: "2026-11-01", to: "2026-12-02" }).success).toBe(false);
    expect(
      rotaGenerateSchema.safeParse({ commandId: newId(), from: "2026-11-01", to: "2027-01-01" }).success,
    ).toBe(true);
    expect(
      workingPatternCreateSchema.safeParse({
        commandId: newId(),
        staffId: newId(),
        shiftId: newId(),
        weekdays: 0,
        validFrom: "2026-11-01",
      }).success,
    ).toBe(false);
    const requirement = {
      commandId: newId(),
      shiftId: newId(),
      name: "Operatives",
      headcount: 2,
      validFrom: "2026-11-01",
    };
    expect(staffingRequirementCreateSchema.safeParse(requirement).success).toBe(false);
    const course = newId();
    expect(
      staffingRequirementCreateSchema.safeParse({ ...requirement, courseIds: [course, course] }).success,
    ).toBe(false);
    expect(staffingRequirementCreateSchema.parse({ ...requirement, courseIds: [course] })).toMatchObject({
      weekdays: ALL_WEEKDAYS,
      appliesWhen: "always",
      validTo: null,
    });
  });
});
