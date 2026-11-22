import { newId } from "@knotworking/core";
import { afterEach, describe, expect, it } from "vitest";
import { READ_TOKEN } from "../testing/fake-api";
import { connect } from "../testing/harness";

const sessions: Awaited<ReturnType<typeof connect>>[] = [];
const session = async (options: Parameters<typeof connect>[0] = {}) => {
  const s = await connect(options);
  sessions.push(s);
  return s;
};
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});
describe("customer and despatch tools", () => {
  it("passes depth and pagination to the impact report without hiding partial coverage", async () => {
    const { call, fake } = await session({ defaultWorkspace: "acme" });
    const lot = newId();
    const r = await call("get_distribution_impact", { lot_id: lot, depth: 1, limit: 2, offset: 4 });
    expect(r.isError).toBe(false);
    expect(r.data.coverage).toMatchObject({ status: "partial", reasons: ["depth_limit"], depth: 1 });
    expect(r.data.deliveries).toMatchObject({ limit: 2, offset: 4 });
    expect(fake.requests.at(-1)).toMatchObject({
      method: "GET",
      path: `/v1/workspaces/acme/despatch/lots/${lot}/impact`,
    });
  });

  it("prepares drafts and pages history through the API without offering confirmation or void", async () => {
    const { call, client, fake } = await session({ defaultWorkspace: "acme" });
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name)).toContain("draft_despatch");
    expect(tools.map((t) => t.name)).not.toContain("confirm_despatch");
    expect(tools.map((t) => t.name)).not.toContain("void_despatch");
    const c = await call("create_customer", { code: "SHOP", name: "Shop", address: "1 Street" });
    expect(c.isError).toBe(false);
    const listing = await call("list_customers", { q: "shop", limit: 1 });
    expect(listing.data.total).toBe(1);
    const draft = {
      customerId: c.data.id,
      despatchedOn: "2026-11-14",
      lines: [{ lotId: newId(), locationId: newId(), quantity: 2, unit: "kg" }],
    };
    const saved = await call("draft_despatch", { draft });
    expect(saved.data.status).toBe("draft");
    expect(fake.requests.at(-1)).toMatchObject({ method: "POST", path: "/v1/workspaces/acme/despatch" });
    expect((await call("list_customer_delivery_sites", { customer_id: c.data.id })).data.sites).toEqual([]);
    expect((await call("get_despatch_operations", { despatch_id: saved.data.id })).data).toMatchObject({
      packages: [],
      proofs: [],
      returns: [],
    });
    const changed = await call("draft_despatch", {
      despatch_id: saved.data.id,
      draft: { ...draft, externalReference: "ORDER-2" },
    });
    expect(changed.data.externalReference).toBe("ORDER-2");
    expect((await call("get_despatch", { despatch_id: saved.data.id })).data.id).toBe(saved.data.id);
    expect((await call("list_despatches", { status: "draft", limit: 1 })).data.total).toBe(1);
    const recipients = await call("get_lot_recipients", { lot_id: draft.lines[0]!.lotId });
    expect(recipients.data.scope).toBe("direct_lot_only");
    expect(tools.find((t) => t.name === "get_lot_recipients")?.description).toContain(
      "not a complete recall",
    );
  });
  it("preserves omitted status on customer update and respects read-token limits", async () => {
    const { call, fake } = await session({ defaultWorkspace: "acme" });
    const c = await call("create_customer", {
      code: "OLD",
      name: "Old",
      address: "Address",
      status: "archived",
    });
    expect(
      (await call("update_customer", { customer_id: c.data.id, changes: { name: "New" } })).data.status,
    ).toBe("archived");
    const reader = await session({ fake, token: READ_TOKEN, defaultWorkspace: "acme" });
    expect((await reader.call("list_customers", { status: "all" })).isError).toBe(false);
    expect(
      (await reader.call("create_customer", { code: "NO", name: "No", address: "Address" })).isError,
    ).toBe(true);
  });
});
