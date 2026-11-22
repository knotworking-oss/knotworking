import { describe, expect, it } from "vitest";
import { weekStart } from "./demand";
import {
  attendanceSettingsSchema,
  attendanceSettingsUpdateSchema,
  buildShifts,
  defaultAttendanceSettings,
  expectedClockKind,
  findPayrollFormat,
  formatBadgeCode,
  kioskClockSchema,
  kioskCredentialSchema,
  kioskPairSchema,
  kioskSealAad,
  localDate,
  normalizeBadgeCode,
  paidMinutes,
  splitOvertime,
  type ClockEventLike,
  type PayrollRow,
} from "./attendance";

const settings = { ...defaultAttendanceSettings };
let n = 0;
const ev = (kind: "in" | "out", at: string, voidedAt: string | null = null): ClockEventLike => ({
  id: `e${++n}`,
  kind,
  at,
  voidedAt,
});

describe("time zones", () => {
  it("gives the local date, across midnight and summer time", () => {
    // 23:30 UTC in June is 00:30 the next day in London (BST).
    expect(localDate("2026-06-10T23:30:00Z", "Europe/London")).toBe("2026-06-11");
    // In January London is on UTC.
    expect(localDate("2026-01-10T23:30:00Z", "Europe/London")).toBe("2026-01-10");
  });

  it("starts weeks on Monday", () => {
    expect(weekStart("2026-11-11")).toBe("2026-11-09"); // Wednesday
    expect(weekStart("2026-11-09")).toBe("2026-11-09");
    expect(weekStart("2026-11-15")).toBe("2026-11-09"); // Sunday
  });

  it("validates settings; the time zone is not one of them", () => {
    // The zone is the workspace's: an attendance settings patch may not set it.
    expect(attendanceSettingsUpdateSchema.safeParse({ timeZone: "Europe/Paris" }).success).toBe(false);
    expect(attendanceSettingsUpdateSchema.safeParse({ roundingMinutes: 5 }).success).toBe(true);
    expect(attendanceSettingsSchema.safeParse({ ...settings, roundingMinutes: 7 }).success).toBe(false);
    expect(attendanceSettingsSchema.safeParse(settings).success).toBe(true);
  });
});

describe("paid minutes", () => {
  it("rounds clock times and deducts the break when the shift is long enough", () => {
    const s = { roundingMinutes: 15, breakAfterHours: 6, breakMinutes: 30 };
    // 07:53 → 08:00, 16:07 → 16:00: 8h, less 30m.
    expect(paidMinutes("2026-03-02T07:53:00Z", "2026-03-02T16:07:00Z", s)).toBe(450);
    // 4h shift: no break.
    expect(paidMinutes("2026-03-02T08:00:00Z", "2026-03-02T12:00:00Z", s)).toBe(240);
    expect(paidMinutes("2026-03-02T08:02:00Z", "2026-03-02T12:01:00Z", { ...s, roundingMinutes: 0 })).toBe(
      239,
    );
  });
});

describe("buildShifts", () => {
  const now = new Date("2026-03-03T12:00:00Z");

  it("pairs ins and outs, ignoring voided events, and dates shifts by the local clock-in", () => {
    const shifts = buildShifts(
      [
        ev("out", "2026-03-02T16:00:00Z"),
        ev("in", "2026-03-02T08:00:00Z"),
        ev("in", "2026-03-02T07:00:00Z", "2026-03-02T09:00:00Z"),
        // A night shift crossing midnight.
        ev("in", "2026-03-02T22:00:00Z"),
        ev("out", "2026-03-03T06:00:00Z"),
      ],
      settings,
      now,
    );
    expect(shifts).toMatchObject([
      { date: "2026-03-02", minutes: 480, paidMinutes: 480, issue: null, open: false },
      { date: "2026-03-02", minutes: 480, issue: null },
    ]);
  });

  it("flags a missed clock-out, a missed clock-in and an overlong shift", () => {
    const shifts = buildShifts(
      [
        ev("in", "2026-03-01T08:00:00Z"),
        ev("in", "2026-03-01T20:00:00Z"),
        ev("out", "2026-03-02T14:00:00Z"), // 18h after the second in: too long
        ev("out", "2026-03-02T15:00:00Z"),
      ],
      settings,
      now,
    );
    expect(shifts.map((s) => s.issue)).toEqual(["missing_out", "too_long", "missing_in"]);
    expect(shifts.every((s) => s.paidMinutes === 0)).toBe(true);
  });

  it("treats a recent clock-in as on site, and an old one as a missed clock-out", () => {
    expect(buildShifts([ev("in", "2026-03-03T08:00:00Z")], settings, now)[0]).toMatchObject({
      open: true,
      issue: null,
    });
    expect(buildShifts([ev("in", "2026-03-02T08:00:00Z")], settings, now)[0]).toMatchObject({
      open: false,
      issue: "missing_out",
    });
  });

  it("expects the next clock event to be out only while within a shift", () => {
    expect(expectedClockKind(null, 16, now)).toBe("in");
    expect(expectedClockKind({ kind: "in", at: "2026-03-03T08:00:00Z" }, 16, now)).toBe("out");
    expect(expectedClockKind({ kind: "in", at: "2026-03-02T08:00:00Z" }, 16, now)).toBe("in");
    expect(expectedClockKind({ kind: "out", at: "2026-03-03T08:00:00Z" }, 16, now)).toBe("in");
  });
});

describe("overtime", () => {
  const day = (date: string, hours: number) => ({
    date,
    start: `${date}T08:00:00Z`,
    paidMinutes: hours * 60,
  });
  it("splits hours past the weekly threshold, per ISO week", () => {
    const shifts = [
      day("2026-03-02", 10),
      day("2026-03-03", 10),
      day("2026-03-04", 10),
      day("2026-03-05", 10),
      day("2026-03-06", 5), // 45h this week
      day("2026-03-09", 8), // next week
    ];
    expect(splitOvertime(shifts, 40)).toEqual({ basicMinutes: 48 * 60, overtimeMinutes: 5 * 60 });
    expect(splitOvertime(shifts, null)).toEqual({ basicMinutes: 53 * 60, overtimeMinutes: 0 });
  });

  it("counts a week that straddles two pay periods whole", () => {
    // 10h a day, Mon 28 Sep to Fri 2 Oct, 40h a week.
    const week = ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"].map((d) =>
      day(d, 10),
    );
    const september = splitOvertime(
      week.filter((s) => s.date <= "2026-09-30"),
      40,
      "2026-09-01",
    );
    const october = splitOvertime(week, 40, "2026-10-01");
    expect(september).toEqual({ basicMinutes: 30 * 60, overtimeMinutes: 0 });
    expect(october).toEqual({ basicMinutes: 10 * 60, overtimeMinutes: 10 * 60 });
  });
});

describe("payroll formats", () => {
  const rows: PayrollRow[] = [
    {
      staffNumber: "100001",
      payrollReference: "17",
      firstName: "Grace",
      lastName: "Hopper",
      shifts: 5,
      basicMinutes: 2400,
      overtimeMinutes: 90,
    },
    {
      staffNumber: "000042",
      payrollReference: null,
      firstName: "=cmd",
      lastName: "Turing",
      shifts: 1,
      basicMinutes: 450,
      overtimeMinutes: 0,
    },
  ];
  const context = {
    from: "2026-03-01",
    to: "2026-03-31",
    settings: { sageBasicPaymentRef: "1", sageOvertimePaymentRef: "2" },
  };

  it("writes the generic CSV with decimal hours, neutralising formulas", () => {
    const csv = findPayrollFormat("generic")!.build(rows, context);
    expect(csv.split("\r\n")).toEqual([
      "Staff number,Payroll reference,First name,Last name,Period start,Period end,Shifts,Basic hours,Overtime hours,Total hours",
      "100001,17,Grace,Hopper,2026-03-01,2026-03-31,5,40,1.5,41.5",
      "000042,,'=cmd,Turing,2026-03-01,2026-03-31,1,7.5,0,7.5",
      "",
    ]);
  });

  it("writes Sage 50 hours per payment reference, and needs the references set", () => {
    const sage = findPayrollFormat("sage50")!;
    expect(sage.verified).toBe(false);
    expect(sage.build(rows, context).split("\r\n")).toEqual([
      "Employee Reference,Payment Reference,Hours",
      "17,1,40",
      "17,2,1.5",
      "000042,1,7.5",
      "",
    ]);
    expect(
      sage.problems(rows, {
        ...context,
        settings: { sageBasicPaymentRef: null, sageOvertimePaymentRef: null },
      }),
    ).toHaveLength(2);
    expect(
      sage.problems([rows[1]!], {
        ...context,
        settings: { sageBasicPaymentRef: "1", sageOvertimePaymentRef: null },
      }),
    ).toEqual([]);
  });
});

describe("kiosk pairing codes", () => {
  it("are forgiving about case, spaces and dashes", () => {
    expect(kioskPairSchema.parse({ code: "abcd-ef23" }).code).toBe("ABCDEF23");
    expect(kioskPairSchema.safeParse({ code: "ABC" }).success).toBe(false);
  });
});

describe("kiosk badges and credentials", () => {
  it("reads a badge code from a scan or a hand-typed copy", () => {
    expect(normalizeBadgeCode("knb:K7QM2XWP9HRT4CNB")).toBe("K7QM2XWP9HRT4CNB");
    expect(normalizeBadgeCode(" k7qm-2xwp 9hrt-4cnb ")).toBe("K7QM2XWP9HRT4CNB");
    expect(formatBadgeCode("K7QM2XWP9HRT4CNB")).toBe("K7QM-2XWP-9HRT-4CNB");
    // Look-alikes (0, 1, I, O) are not in the alphabet; the length is exact.
    expect(normalizeBadgeCode("K7QM2XWP9HRT4CN0")).toBeNull();
    expect(normalizeBadgeCode("K7QM2XWP9HRT4CN")).toBeNull();
    expect(normalizeBadgeCode("100001")).toBeNull();
  });

  it("takes a staff number and PIN, or a badge (with or without the PIN), never both identifiers", () => {
    expect(kioskCredentialSchema.safeParse({ staffNumber: "100001", pin: "482915" }).success).toBe(true);
    expect(kioskCredentialSchema.safeParse({ staffNumber: "100001" }).success).toBe(false);
    expect(kioskCredentialSchema.safeParse({ badge: "knb:K7QM2XWP9HRT4CNB" }).data).toEqual({
      badge: "K7QM2XWP9HRT4CNB",
    });
    expect(kioskCredentialSchema.safeParse({ badge: "K7QM2XWP9HRT4CNB", pin: "482915" }).success).toBe(true);
    expect(
      kioskCredentialSchema.safeParse({ badge: "K7QM2XWP9HRT4CNB", staffNumber: "100001", pin: "482915" })
        .success,
    ).toBe(false);
    expect(kioskCredentialSchema.safeParse({ badge: "nope" }).success).toBe(false);
    expect(kioskClockSchema.safeParse({ staffNumber: "100001", pin: "482915", kind: "in" }).success).toBe(
      true,
    );
  });

  it("binds a sealed entry to its client id, type and time", () => {
    expect(kioskSealAad({ clientId: "c", type: "clock_in", at: "2026-11-13T08:00:00.000Z" })).toBe(
      "c|clock_in|2026-11-13T08:00:00.000Z",
    );
  });

  it("defaults to badges with the PIN, a 72-hour replay window and no site rules", () => {
    expect(defaultAttendanceSettings).toMatchObject({
      badgeRequiresPin: true,
      offlineReplayHours: 72,
      visitorSiteRules: null,
    });
    const parsed = attendanceSettingsSchema.parse({ ...defaultAttendanceSettings, visitorSiteRules: "  " });
    expect(parsed.visitorSiteRules).toBeNull();
    expect(
      attendanceSettingsSchema.safeParse({ ...defaultAttendanceSettings, offlineReplayHours: 169 }).success,
    ).toBe(false);
  });
});
