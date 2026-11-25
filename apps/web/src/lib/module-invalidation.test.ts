import type { SyncChange } from "@knotworking/core";
import { describe, expect, it } from "vitest";
import { shouldRefreshModulePage } from "./module-invalidation";

const change = (entity: SyncChange["entity"]): SyncChange[] => [
  {
    id: "1",
    entity,
    entityId: "x",
    action: "upsert",
    data: { id: "x" },
    actorId: null,
    createdAt: "2026-01-01T00:00:00Z",
  },
];
describe("module read-model invalidation", () => {
  it("refreshes server-rendered currency and date context when workspace settings change", () => {
    expect(shouldRefreshModulePage("/acme/costing", change("workspace"))).toBe(true);
    expect(shouldRefreshModulePage("/acme/purchasing/orders/one", change("workspace"))).toBe(true);
  });
  it("refreshes downstream derived views when ingredients, ledger entries or prices change", () => {
    expect(shouldRefreshModulePage("/acme/costing", change("purchase_invoice"))).toBe(true);
    expect(shouldRefreshModulePage("/acme/labels/one", change("item"))).toBe(true);
    expect(shouldRefreshModulePage("/acme/stock", change("production_reservation"))).toBe(true);
    expect(shouldRefreshModulePage("/acme/purchasing/suggestions", change("demand_line"))).toBe(true);
    expect(shouldRefreshModulePage("/acme/production/batches/one", change("haccp_corrective_action"))).toBe(
      true,
    );
  });
  it("refreshes customer/despatch views and protected stock recipient panels", () => {
    expect(shouldRefreshModulePage("/acme/despatch", change("customer"))).toBe(true);
    expect(shouldRefreshModulePage("/acme/stock/lots/one", change("despatch"))).toBe(true);
    expect(shouldRefreshModulePage("/acme/despatch/new", change("production_reservation"))).toBe(true);
  });
  it("refreshes a module's views when a soft dependency (`enhancedBy`) changes", () => {
    expect(shouldRefreshModulePage("/acme/haccp/deviations", change("production_batch"))).toBe(true);
    expect(shouldRefreshModulePage("/acme/quality/complaints", change("stock_lot"))).toBe(true);
    expect(shouldRefreshModulePage("/acme/production/daily-demand", change("demand_line"))).toBe(true);
  });
  it("leaves unrelated screens and task views alone", () => {
    expect(shouldRefreshModulePage("/acme/tasks", change("task"))).toBe(false);
    expect(shouldRefreshModulePage("/acme/people", change("stock_movement"))).toBe(false);
    expect(shouldRefreshModulePage("/acme/stock", change("user"))).toBe(false);
  });
});

describe("sales read models", () => {
  it("refreshes commercial views for order revisions and despatch/return changes", () => {
    expect(shouldRefreshModulePage("/acme/sales/orders/one", change("sales_order"))).toBe(true);
    expect(shouldRefreshModulePage("/acme/sales/commitments", change("despatch"))).toBe(true);
    expect(shouldRefreshModulePage("/acme/sales/prices", change("sales_price"))).toBe(true);
  });
});
