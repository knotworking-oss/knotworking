import { describe, expect, it } from "vitest";
import {
  addMonthsIso,
  trainingCourseCreateSchema,
  trainingStatus,
  type TrainingRecordForStatus,
} from "./training";

const today = "2026-06-15";
const rec = (fields: Partial<TrainingRecordForStatus> = {}): TrainingRecordForStatus => ({
  completedOn: "2026-01-10",
  outcome: "competent",
  expiresOn: null,
  sopVersionId: null,
  signedOffAt: "2026-01-11T09:00:00Z",
  voidedAt: null,
  ...fields,
});
const status = (input: Partial<Parameters<typeof trainingStatus>[0]>) =>
  trainingStatus({ records: [], requiresSignOff: true, today, ...input });

describe("addMonthsIso", () => {
  it("clamps to the end of shorter months", () => {
    expect(addMonthsIso("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonthsIso("2028-01-31", 1)).toBe("2028-02-29");
    expect(addMonthsIso("2026-06-15", 12)).toBe("2027-06-15");
    expect(addMonthsIso("2026-11-30", 3)).toBe("2027-02-28");
  });
});

describe("trainingStatus", () => {
  it("is current when signed off and in date", () => {
    expect(status({ records: [rec({ expiresOn: "2027-01-10" })] })).toMatchObject({
      status: "current",
      completedOn: "2026-01-10",
      expiresOn: "2027-01-10",
    });
  });

  it("is expiring within 30 days, and expired after", () => {
    expect(status({ records: [rec({ expiresOn: "2026-07-10" })] }).status).toBe("expiring");
    expect(status({ records: [rec({ expiresOn: "2026-06-14" })] }).status).toBe("expired");
    // The latest training counts: a refresher makes it current again.
    const refreshed = [
      rec({ expiresOn: "2026-06-14" }),
      rec({ completedOn: "2026-06-01", expiresOn: "2027-06-01" }),
    ];
    expect(status({ records: refreshed }).status).toBe("current");
  });

  it("waits for a sign-off when the course needs one", () => {
    const unsigned = rec({ signedOffAt: null });
    expect(status({ records: [unsigned] }).status).toBe("pending_sign_off");
    expect(status({ records: [unsigned], requiresSignOff: false }).status).toBe("current");
    // Attended doesn't make anyone competent; it counts only where no sign-off is needed.
    expect(status({ records: [rec({ outcome: "attended", signedOffAt: null })] }).status).toBe(
      "not_required",
    );
    expect(status({ records: [rec({ outcome: "attended" })], requiresSignOff: false }).status).toBe(
      "current",
    );
    // A refresher awaiting sign-off is what to act on once the old training has lapsed.
    const lapsed = [rec({ expiresOn: "2026-06-01" }), rec({ completedOn: "2026-06-10", signedOffAt: null })];
    expect(status({ records: lapsed }).status).toBe("pending_sign_off");
  });

  it("never counts voided or not-yet-competent training", () => {
    const records = [rec({ voidedAt: "2026-02-01T00:00:00Z" }), rec({ outcome: "not_yet_competent" })];
    expect(status({ records }).status).toBe("not_required");
    expect(status({ records, requirement: { dueWithinDays: null, startDate: null } }).status).toBe("missing");
  });

  it("is outdated when the SOP has a newer approved version", () => {
    const onV1 = [rec({ sopVersionId: "v1" })];
    expect(status({ records: onV1, currentSopVersionId: "v1" }).status).toBe("current");
    expect(status({ records: onV1, currentSopVersionId: "v2" }).status).toBe("outdated");
  });

  it("reports when missing training is due, and whether it is overdue", () => {
    expect(status({ requirement: { dueWithinDays: 30, startDate: "2026-06-01" } })).toMatchObject({
      status: "missing",
      required: true,
      dueOn: "2026-07-01",
      overdue: false,
    });
    expect(status({ requirement: { dueWithinDays: 7, startDate: "2026-06-01" } })).toMatchObject({
      dueOn: "2026-06-08",
      overdue: true,
    });
    expect(status({ requirement: { dueWithinDays: null, startDate: "2026-06-01" } })).toMatchObject({
      dueOn: null,
      overdue: false,
    });
  });
});

describe("course schema", () => {
  it("ties SOP courses to an SOP", () => {
    const base = { code: "HYG-1", title: "Handwashing" };
    expect(trainingCourseCreateSchema.safeParse({ ...base, kind: "sop" }).success).toBe(false);
    expect(
      trainingCourseCreateSchema.safeParse({
        ...base,
        kind: "induction",
        sopId: "01900000-0000-7000-8000-000000000000",
      }).success,
    ).toBe(false);
    expect(trainingCourseCreateSchema.safeParse({ ...base, kind: "induction" }).success).toBe(true);
  });
});
