import { describe, expect, it } from "vitest";
import type { BatchCostRow, ComplaintRow, PestVisit, StorageReading } from "@/lib/api";
import {
  batchCostsCsv,
  collectPages,
  complaintsCsv,
  csvDocument,
  csvFileName,
  glassBreakagesCsv,
  glassChecksCsv,
  pestVisitsCsv,
  storageReadingsCsv,
} from "./csv-export";

describe("csvDocument", () => {
  it("starts with a byte order mark, uses CRLF and ends with a line break", () => {
    const text = csvDocument([
      ["a", "b"],
      ["1", 2],
    ]);
    expect(text.startsWith("﻿")).toBe(true);
    expect(text.slice(1)).toBe("a,b\r\n1,2\r\n");
  });

  it("quotes commas, quotes and line breaks", () => {
    expect(csvDocument([['say "hi", then\nleave']]).slice(1)).toBe('"say ""hi"", then\nleave"\r\n');
  });

  it("neutralises formulas in text cells, not in numbers", () => {
    const text = csvDocument([["=1+1", "+44 20 7946 0000", "-3", "@SUM(A1)", "  =x", -3.5, "fine"]]).slice(1);
    expect(text).toBe("'=1+1,'+44 20 7946 0000,'-3,'@SUM(A1),'  =x,-3.5,fine\r\n");
  });
});

describe("csvFileName", () => {
  it("makes a plain lower-case name with the date", () => {
    expect(csvFileName("Purchase orders / Q4", "2026-11-13")).toBe("purchase-orders-q4-2026-11-13.csv");
    expect(csvFileName("???", "2026-11-13")).toBe("export-2026-11-13.csv");
  });
});

describe("collectPages", () => {
  it("fetches pages until the total is reached", async () => {
    const all = Array.from({ length: 7 }, (_, i) => i);
    const offsets: number[] = [];
    const rows = await collectPages(async (offset) => {
      offsets.push(offset);
      return { rows: all.slice(offset, offset + 3), total: all.length };
    });
    expect(rows).toEqual(all);
    expect(offsets).toEqual([0, 3, 6]);
  });

  it("stops at the cap and on an empty page", async () => {
    expect(await collectPages(async (o) => ({ rows: [o, o + 1], total: 100 }), 5)).toHaveLength(5);
    expect(await collectPages(async () => ({ rows: [], total: 10 }))).toEqual([]);
  });
});

describe("list builders", () => {
  it("puts a header first and keeps a hostile description from becoming a formula", () => {
    const complaint = {
      reference: "CMP-0001",
      receivedOn: "2026-11-02",
      status: "open",
      category: "foreign_body",
      severity: "major",
      customer: "-Corner Shop",
      item: { code: "SAU-001", name: "Tomato sauce" },
      lot: { lotCode: "L1" },
      reportedLotCode: null,
      description: '=HYPERLINK("http://evil","click")',
      nonconformanceCount: 1,
      createdByName: "Ada",
      closedByName: null,
    } as unknown as ComplaintRow;
    const csv = csvDocument(complaintsCsv([complaint]));
    const [header, row] = csv.slice(1).split("\r\n");
    expect(header!.split(",")[0]).toBe("Reference");
    expect(row).toContain("'-Corner Shop");
    expect(row).toContain(`"'=HYPERLINK(""http://evil"",""click"")"`);
  });

  it("writes batch costs with numbers as numbers and missing values empty", () => {
    const batch = {
      batchCode: "B-1",
      status: "completed",
      costingDate: "2026-11-03",
      outputItem: { code: "SAU-001", name: "Tomato sauce" },
      cost: {
        produced: { display: 120, displayUnit: "kg" },
        yieldPercent: 98.5,
        actualCost: 412.3,
        costPerUnit: 3.4358,
        standardCostPerUnit: null,
        variance: -12.5,
        variancePercent: -2.9,
        estimatedPercent: 0,
        provisional: false,
        costComplete: true,
      },
    } as unknown as BatchCostRow;
    const rows = batchCostsCsv([batch]);
    expect(rows[1]).toContain(-12.5);
    expect(csvDocument(rows)).toContain(
      "B-1,completed,2026-11-03,SAU-001,Tomato sauce,120,kg,98.5,412.3,3.4358,,-12.5,-2.9,0,No,Yes",
    );
  });

  it("flags readings replaced by a correction and keeps the numeric value", () => {
    const reading = {
      checkedAt: "2026-11-05T08:30:00.000Z",
      unit: { name: "Chiller 1", code: "CH1" },
      value: 8.2,
      readingText: "8.2 °C",
      limitsText: "0 to 5 °C",
      withinLimits: false,
      recordedByName: "Ada",
      source: "manual",
      reviewStatus: "approved",
      correctedByReadingId: "r2",
      correctiveActions: [{ title: "Chiller 1: 8.2 °C" }],
    } as unknown as StorageReading;
    const [, row] = storageReadingsCsv([reading]);
    expect(row![0]).toBe("2026-11-05T08:30:00.000Z");
    expect(row![3]).toBe(8.2);
    expect(row).toContain("No");
    expect(row).toContain("Yes");
  });

  it("gives a pest visit with no findings a row of its own, and one row per finding otherwise", () => {
    const base = {
      visitedOn: "2026-11-04",
      contractor: "Rentokil",
      technician: null,
      summary: null,
      recommendations: null,
      actionsTaken: null,
      nextVisitOn: "2026-12-04",
      recordedByName: "Ada",
      correctedByVisitId: null,
    };
    const none = { ...base, findings: [] } as unknown as PestVisit;
    const two = {
      ...base,
      findings: [
        { device: { code: "RB1", location: "Door" }, activity: "none", pest: null, count: 0 },
        { device: null, location: "Yard", activity: "high", pest: "Rat", count: 2 },
      ],
    } as unknown as PestVisit;
    expect(pestVisitsCsv([none])).toHaveLength(2);
    expect(pestVisitsCsv([two])).toHaveLength(3);
  });
});

describe("glass CSV", () => {
  it("has a header and one row per check or breakage", () => {
    const checks = glassChecksCsv([
      {
        checkedAt: "2026-11-05T09:00:00.000Z",
        area: { name: "Packing hall" },
        item: { kind: "glass", description: "East window" },
        condition: "damaged",
        note: "Cracked",
        recordedByName: "Ada",
        correctsCheckId: null,
        correctionReason: null,
        correctedByCheckId: null,
      },
    ] as never);
    expect(checks).toHaveLength(2);
    expect(checks[1]).toContain("Damaged");
    const breakages = glassBreakagesCsv([
      {
        occurredAt: "2026-11-05T09:00:00.000Z",
        area: { name: "Packing hall" },
        item: null,
        description: "Diffuser cracked",
        quarantined: "Line 1",
        cleanDown: null,
        status: "open",
        raisedByName: "Ada",
        source: "api",
      },
    ] as never);
    expect(breakages).toHaveLength(2);
    expect(breakages[1]).toContain("Area held");
  });
});
