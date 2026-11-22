import { describe, expect, it } from "vitest";
import {
  formatAnalyteLimit,
  judgeResult,
  sampleOutcome,
  summarizeTrend,
  testPlanDue,
  testPlanInputSchema,
  testSampleCreateSchema,
} from "./testing";

const numeric = { min: null, max: 100, limitText: null };
const written = { min: null, max: null, limitText: "Not detected" };

describe("judgeResult", () => {
  it("judges numeric limits by the value, and lets a person fail but never pass an out-of-range value", () => {
    expect(judgeResult(numeric, { value: 99 })).toBe("pass");
    expect(judgeResult(numeric, { value: 101 })).toBe("fail");
    expect(judgeResult(numeric, { value: 101, outcome: "pass" })).toBe("fail");
    expect(judgeResult(numeric, { value: 50, outcome: "fail" })).toBe("fail");
    expect(judgeResult({ min: 4, max: 4.6, limitText: null }, { value: 3.9 })).toBe("fail");
  });

  it("needs a person's verdict on a written limit and a value on a numeric one", () => {
    expect(judgeResult(written, { outcome: "pass" })).toBe("pass");
    expect(() => judgeResult(written, {})).toThrow(/written limit/);
    expect(() => judgeResult(numeric, { outcome: "pass" })).toThrow(/value/);
    // With both kinds of limit, a verdict on the written one is enough.
    expect(judgeResult({ min: null, max: 10, limitText: "or not detected" }, { outcome: "pass" })).toBe(
      "pass",
    );
  });
});

describe("sampleOutcome", () => {
  it("fails on any fail, stays pending while any result is, else passes", () => {
    expect(sampleOutcome(["pass", "pending", "fail"])).toBe("fail");
    expect(sampleOutcome(["pass", "pending"])).toBe("pending");
    expect(sampleOutcome(["pass", "pass"])).toBe("pass");
    expect(sampleOutcome([])).toBe("pending");
  });
});

describe("testPlanDue", () => {
  it("is due from the start until sampled, then frequency days after the last sample", () => {
    expect(
      testPlanDue({ lastSampledOn: null, frequencyDays: 7, startedOn: "2026-11-01", today: "2026-11-14" }),
    ).toEqual({
      nextDueOn: "2026-11-01",
      state: "overdue",
      daysOverdue: 13,
    });
    expect(
      testPlanDue({
        lastSampledOn: "2026-11-14",
        frequencyDays: 7,
        startedOn: "2026-11-01",
        today: "2026-11-14",
      }).state,
    ).toBe("due_soon");
    expect(
      testPlanDue({
        lastSampledOn: "2026-11-07",
        frequencyDays: 7,
        startedOn: "2026-11-01",
        today: "2026-11-14",
      }).state,
    ).toBe("due");
    expect(
      testPlanDue({
        lastSampledOn: "2026-11-14",
        frequencyDays: 30,
        startedOn: "2026-11-01",
        today: "2026-11-14",
      }),
    ).toMatchObject({
      nextDueOn: "2026-12-14",
      state: "ok",
    });
  });
});

describe("summarizeTrend", () => {
  it("counts judged results and fails, and averages numeric values", () => {
    const s = summarizeTrend([
      { sampledOn: "2026-01-02", value: 10, outcome: "pass" },
      { sampledOn: "2026-01-01", value: 20, outcome: "fail" },
      { sampledOn: "2026-01-03", value: null, outcome: "pending" },
    ]);
    expect(s).toMatchObject({ results: 2, fails: 1, failRate: 0.5, mean: 15, min: 10, max: 20 });
    expect(s.latest?.sampledOn).toBe("2026-01-02");
  });
});

describe("validation", () => {
  it("ties plans and samples to the right subject", () => {
    const id = "01a1db4e-9e70-72e5-80c2-fe782ad6a75b";
    expect(
      testPlanInputSchema.safeParse({ name: "x", subject: "lot", itemId: id, frequencyDays: 30 }).success,
    ).toBe(true);
    expect(
      testPlanInputSchema.safeParse({ name: "x", subject: "point", samplingPointId: id, frequencyDays: 7 })
        .success,
    ).toBe(false);
    expect(
      testSampleCreateSchema.safeParse({ subject: "lot", samplingPointId: id, sampledOn: "2026-01-01" })
        .success,
    ).toBe(false);
    expect(
      testSampleCreateSchema.safeParse({ subject: "point", samplingPointId: id, sampledOn: "2026-01-01" })
        .success,
    ).toBe(true);
  });

  it("formats limits", () => {
    expect(formatAnalyteLimit({ min: null, max: 100, unit: "cfu/g", limitText: null })).toBe("≤ 100 cfu/g");
    expect(formatAnalyteLimit({ min: null, max: null, unit: null, limitText: "Not detected" })).toBe(
      "Not detected",
    );
  });
});
