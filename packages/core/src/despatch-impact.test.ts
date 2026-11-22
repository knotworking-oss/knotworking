import { describe, expect, it } from "vitest";
import {
  despatchImpactCsv,
  despatchImpactQuerySchema,
  type DespatchImpactReport,
  type ImpactDelivery,
} from "./despatch-impact";
import { parseCsv } from "./csv";
import { stockAmount } from "./stock";

function report(lines: ImpactDelivery[] = []): DespatchImpactReport {
  return {
    rootLotId: "root",
    generatedAt: "2026-11-14T12:00:00Z",
    scope: "forward_production_and_despatch",
    coverage: {
      status: "partial",
      reasons: ["depth_limit"],
      depth: 1,
      limits: { lots: 2000, batches: 2000, links: 10000 },
    },
    lots: [],
    batches: [],
    summary: { lots: 1, batches: 0, despatches: 0, customers: 0, deliveryLines: lines.length },
    deliveries: { lines, total: lines.length, limit: 50, offset: 0 },
  };
}
describe("distribution impact exports", () => {
  it("retains partial coverage and the selected root even when no deliveries were found", () => {
    const csv = despatchImpactCsv(report());
    const rows = parseCsv(csv);
    expect(rows[0]).toEqual(["Forward distribution impact", "root"]);
    expect(rows).toContainEqual(["Recorded trace coverage", "partial"]);
    expect(csv).toContain("further production or customer-return links remain");
    expect(csv).toContain("0 / 0");
    expect(csv).toContain("unrecorded movements");
  });
  it("preserves historical contact fields and each delivery's unit without interpreting spreadsheet formulas", () => {
    const base: ImpactDelivery = {
      lineId: "line1",
      despatchId: "d1",
      reference: "DN-1",
      despatchedOn: "2026-11-14",
      customerId: "shop",
      customerCode: "SHOP",
      customerName: '=HYPERLINK("https://bad.test")',
      customerAddress: "1 Old Road\nUnit A",
      deliveryAddress: "Warehouse, London",
      contactName: "+SUM(1,2)",
      email: "buyer@example.test",
      phone: "@phone",
      externalReference: "ORDER-1",
      lotId: "lot1",
      lotCode: "L-1",
      itemCode: "CAKE",
      itemName: "Cake",
      amount: stockAmount(3, { unit: "each" }),
    };
    const second = {
      ...base,
      lineId: "line2",
      itemCode: "SOUP",
      itemName: "Soup",
      lotId: "lot2",
      amount: stockAmount(500, { unit: "l" as const }),
    };
    const rows = parseCsv(despatchImpactCsv(report([base, second])));
    const header = rows.findIndex((r) => r[0] === "Despatch");
    const first = rows[header + 1]!;
    const next = rows[header + 2]!;
    expect(first[3]).toBe("'" + base.customerName);
    expect(first[4]).toBe(base.customerAddress);
    expect(first[5]).toBe("Warehouse, London");
    expect(first[6]).toBe("'+SUM(1,2)");
    expect(first[7]).toBe("buyer@example.test");
    expect(first.slice(13, 15)).toEqual(["3", "each"]);
    expect(next.slice(13, 15)).toEqual(["0.5", "l"]);
  });
  it("bounds trace depth and delivery pages while accepting an omitted/default query", () => {
    expect(despatchImpactQuerySchema.parse({})).toEqual({ depth: 10, limit: 50, offset: 0 });
    expect(despatchImpactQuerySchema.safeParse({ depth: 21 }).success).toBe(false);
    expect(despatchImpactQuerySchema.safeParse({ limit: 201 }).success).toBe(false);
    expect(despatchImpactQuerySchema.safeParse({ offset: -1 }).success).toBe(false);
  });
});
