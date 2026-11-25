import { describe, expect, it } from "vitest";
import { accountingPostingSchema, accountingReceiptSchema, newId } from "./index";
const invoice = () => ({
  version: 1,
  provider: "example_ledger",
  connectionId: newId(),
  companyId: "test",
  kind: "purchase_invoice",
  sourceId: newId(),
  sourceRevision: 1,
  supplierReference: "SUP001",
  reference: "INV001",
  date: "2026-11-15",
  currency: "GBP",
  lines: [
    { accountReference: "5000", taxReference: "T1", description: "Ingredients", net: "0.10", tax: "0.02" },
    { accountReference: "5000", taxReference: "T1", description: "Ingredients", net: "0.20", tax: "0.04" },
  ],
  net: "0.30",
  tax: "0.06",
  gross: "0.36",
});
describe("prepared accounting snapshots", () => {
  it("reconciles pennies exactly", () => {
    expect(accountingPostingSchema.parse(invoice()).gross).toBe("0.36");
  });
  it.each(["-1.00", "1e2", "NaN", "abc", "01.00", "9999999999999.00"])(
    "rejects invalid amount %s without throwing from validation",
    (gross) => {
      expect(accountingPostingSchema.safeParse({ ...invoice(), gross }).success).toBe(false);
    },
  );
  it("rejects inconsistent totals and invalid dates", () => {
    for (const change of [
      { gross: "0.35" },
      { net: "0.29" },
      { tax: "0.07" },
      { date: "2026-02-30" },
      { currency: "NOT_A_CURRENCY" },
      { provider: "Invalid Provider!" },
      { kind: "sales_invoice" },
      { lines: [] },
    ])
      expect(accountingPostingSchema.safeParse({ ...invoice(), ...change }).success).toBe(false);
  });
  it("requires explicit account and tax mappings", () => {
    const input = invoice();
    delete (input.lines[0] as Partial<(typeof input.lines)[0]>).taxReference;
    expect(accountingPostingSchema.safeParse(input).success).toBe(false);
  });
});

describe("extensible accounting destinations and currency precision", () => {
  it.each(["sage_50_accounts_uk", "xero", "quickbooks", "community_adapter"])(
    "accepts provider identifier %s without changing the contract",
    (provider) => {
      expect(accountingPostingSchema.parse({ ...invoice(), provider }).provider).toBe(provider);
    },
  );
  it.each(["GBP", "USD", "EUR"])("supports two-decimal currency %s", (currency) => {
    expect(accountingPostingSchema.safeParse({ ...invoice(), currency }).success).toBe(true);
  });
  it.each([
    { currency: "JPY", net: "10", tax: "1", gross: "11" },
    { currency: "KWD", net: "0.100", tax: "0.020", gross: "0.120" },
  ])("validates exact amounts for $currency", (money) => {
    const input = {
      ...invoice(),
      ...money,
      lines: [{ ...invoice().lines[0], net: money.net, tax: money.tax }],
    };
    expect(accountingPostingSchema.safeParse(input).success).toBe(true);
    expect(accountingPostingSchema.safeParse({ ...input, gross: money.gross + "0" }).success).toBe(false);
  });
  it("rejects fractional pennies without rounding", () => {
    expect(accountingPostingSchema.safeParse({ ...invoice(), gross: "0.360" }).success).toBe(false);
  });
});

describe("currency-aware accounting read-back", () => {
  it.each([
    { currency: "JPY", net: "10", tax: "1", gross: "11" },
    { currency: "KWD", net: "0.100", tax: "0.020", gross: "0.120" },
  ])("validates receipt precision and totals for $currency", (money) => {
    const receipt = {
      provider: "community_ledger",
      connectionId: newId(),
      companyId: "test",
      postingKey: newId(),
      externalId: "123",
      ...money,
    };
    expect(accountingReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(accountingReceiptSchema.safeParse({ ...receipt, tax: "1.12" }).success).toBe(false);
    expect(accountingReceiptSchema.safeParse({ ...receipt, gross: money.net }).success).toBe(false);
  });
});

it("retains an explicit due date without inventing one for other adapters", () => {
  expect(accountingPostingSchema.parse(invoice())).not.toHaveProperty("dueDate");
  expect(accountingPostingSchema.parse({ ...invoice(), dueDate: "2026-12-15" })).toHaveProperty(
    "dueDate",
    "2026-12-15",
  );
  expect(accountingPostingSchema.safeParse({ ...invoice(), dueDate: "2026-02-30" }).success).toBe(false);
});
