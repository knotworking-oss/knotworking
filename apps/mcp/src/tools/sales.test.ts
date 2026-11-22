import { newId } from "@knotworking/core";
import { afterEach, describe, expect, it } from "vitest";
import { connect } from "../testing/harness";
import { READ_TOKEN } from "../testing/fake-api";
const sessions: Awaited<ReturnType<typeof connect>>[] = [];
const session = async (options: Parameters<typeof connect>[0] = {}) => {
  const s = await connect(options);
  sessions.push(s);
  return s;
};
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});
describe("sales assistant transport", () => {
  it("prepares drafts and passes reviewed revisions, prices, commands and date paging", async () => {
    const { call, client, fake } = await session({ defaultWorkspace: "acme" });
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toContain("draft_sales_document");
    expect(tools).not.toContain("confirm_sales_order");
    expect(tools).not.toContain("agree_sales_price");
    const document = {
      customerId: newId(),
      currency: "GBP",
      lines: [{ itemId: newId(), quantity: 2, unit: "kg", dueOn: "2026-11-15", unitPrice: 3.45 }],
    };
    const created = await call("draft_sales_document", {
      request: { commandId: newId(), kind: "order", document },
    });
    expect(created.isError).toBe(false);
    expect(created.data.status).toBe("draft");
    expect((await call("list_sales_documents", { limit: 1, offset: 0, status: "draft" })).data.total).toBe(1);
    expect((await call("get_sales_document", { document_id: created.data.id })).data.lines[0].unitPrice).toBe(
      3.45,
    );
    const stale = await call("draft_sales_document", {
      document_id: created.data.id,
      request: { commandId: newId(), expectedRevision: 9, reason: "Edit", document },
    });
    expect(stale.isError).toBe(true);
    const saved = await call("draft_sales_document", {
      document_id: created.data.id,
      request: { commandId: newId(), expectedRevision: 1, reason: "Customer changed date", document },
    });
    expect(saved.data.revision).toBe(2);
    const report = await call("get_sales_commitments", {
      query: { from: "2026-11-01", to: "2026-11-30", limit: 5, offset: 2 },
    });
    expect(report.data).toMatchObject({ forecastIncluded: false, limit: 5, offset: 2 });
    expect(fake.requests.at(-1)?.path).toBe("/v1/workspaces/acme/sales/commitments");
    expect((await call("list_sales_prices", {})).data.prices).toEqual([]);
  });
  it("enforces read tokens for draft writes", async () => {
    const reader = await session({ defaultWorkspace: "acme", token: READ_TOKEN });
    expect((await reader.call("list_sales_documents", {})).isError).toBe(false);
    expect(
      (
        await reader.call("draft_sales_document", {
          request: {
            commandId: newId(),
            kind: "quote",
            document: {
              customerId: newId(),
              currency: "GBP",
              lines: [{ itemId: newId(), quantity: 1, unit: "kg", dueOn: "2026-11-15", unitPrice: 1 }],
            },
          },
        })
      ).isError,
    ).toBe(true);
  });
});
