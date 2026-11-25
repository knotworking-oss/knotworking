import { newId, type AccountingPosting, type AccountingReceipt } from "@knotworking/core";
import {
  accountingConnections,
  accountingPostings,
  accountingPostingEvents,
  syncChanges,
  workspaces,
  type DbHandle,
} from "@knotworking/db";
import { createTestDb } from "@knotworking/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  accountingPostingHistory,
  claimAccountingPosting,
  confirmAccountingPosting,
  dispatchAccountingPosting,
  enqueueAccountingPosting,
  recordAccountingOutcome,
  retryAccountingPosting,
} from "./outbox";
import type { AccountingAdapter } from "./adapter";

const actor = "test-connector";
const connectionId = newId();
const binding = {
  provider: "example_ledger",
  connectionId,
  companyId: "test-company",
  capabilities: { postingKinds: ["purchase_invoice"] as const, currencies: ["GBP", "USD", "JPY", "KWD"] },
};
type PurchaseInvoice = Extract<AccountingPosting, { kind: "purchase_invoice" }>;
function document(extra: Partial<PurchaseInvoice> = {}): PurchaseInvoice {
  return {
    version: 1,
    provider: binding.provider,
    connectionId,
    companyId: "test-company",
    kind: "purchase_invoice",
    sourceId: newId(),
    sourceRevision: 1,
    supplierReference: "SUP001",
    reference: "INV-123",
    date: "2026-11-15",
    currency: "GBP",
    lines: [
      { accountReference: "5000", taxReference: "T1", description: "Ingredients", net: "10.00", tax: "2.00" },
    ],
    net: "10.00",
    tax: "2.00",
    gross: "12.00",
    ...extra,
  };
}
function receipt(id: string, extra: Partial<AccountingReceipt> = {}): AccountingReceipt {
  return {
    provider: binding.provider,
    connectionId,
    companyId: "test-company",
    postingKey: id,
    externalId: newId(),
    currency: "GBP",
    net: "10.00",
    tax: "2.00",
    gross: "12.00",
    ...extra,
  };
}

describe("Provider-neutral durable posting boundary (test adapters only)", () => {
  let handle: DbHandle, ws: string, other: string;
  beforeAll(async () => {
    handle = await createTestDb();
    ws = newId();
    other = newId();
    await handle.db.insert(workspaces).values([
      { id: ws, name: "Finance test", slug: "finance-test" },
      { id: other, name: "Other", slug: "other-finance" },
    ]);
    for (const workspaceId of [ws, other])
      await handle.db.insert(accountingConnections).values({
        id: connectionId,
        workspaceId,
        name: "Test setup",
        provider: binding.provider,
        companyId: binding.companyId,
      });
  }, 30000);
  afterAll(async () => {
    await handle?.close();
  });
  const enqueue = async (input = document(), workspace = ws) => {
    await handle.db
      .insert(accountingConnections)
      .values({
        id: input.connectionId,
        workspaceId: workspace,
        name: "Test setup",
        provider: input.provider,
        companyId: input.companyId,
      })
      .onConflictDoNothing();
    return enqueueAccountingPosting(handle.db, workspace, actor, input);
  };
  const claim = (id: string) => claimAccountingPosting(handle.db, ws, id, actor);
  const history = (id: string) => accountingPostingHistory(handle.db, ws, id);

  it("isolates source deduplication and identical external IDs across connections/providers", async () => {
    const input = document();
    const first = await enqueue(input);
    const destination = { provider: "another_ledger", connectionId: newId(), companyId: input.companyId };
    const second = await enqueue({ ...input, ...destination });
    expect(second.id).not.toBe(first.id);
    for (const row of [first, second]) {
      const connector: AccountingAdapter = {
        ...binding,
        provider: row.provider,
        connectionId: row.connectionId,
        post: async ({ postingKey }) => ({
          outcome: "posted",
          receipt: receipt(postingKey, {
            provider: row.provider,
            connectionId: row.connectionId,
            externalId: "same-provider-local-id",
          }),
        }),
      };
      expect((await dispatchAccountingPosting(handle.db, ws, row.id, actor, connector))?.state).toBe(
        "posted",
      );
    }
  });
  it("refuses wrong provider, connection, company and unsupported capabilities before IO", async () => {
    const row = await enqueue();
    let calls = 0;
    const connector: AccountingAdapter = {
      ...binding,
      post: async () => {
        calls++;
        return { outcome: "unknown", evidence: "test" };
      },
    };
    for (const override of [
      { provider: "another_ledger" },
      { connectionId: newId() },
      { companyId: "wrong" },
      { capabilities: { ...binding.capabilities, currencies: ["USD"] } },
      { capabilities: { ...binding.capabilities, postingKinds: [] } },
    ])
      await expect(
        dispatchAccountingPosting(handle.db, ws, row.id, actor, { ...connector, ...override }),
      ).rejects.toMatchObject({ code: "accounting_conflict" });
    expect(calls).toBe(0);
    expect((await history(row.id)).posting.state).toBe("queued");
    expect((await history(row.id)).posting.attempts).toBe(0);
  });
  it("keeps provider and company immutable within an existing connection", async () => {
    const input = document();
    await enqueue(input);
    await expect(enqueue({ ...input, sourceId: newId(), provider: "another_ledger" })).rejects.toMatchObject({
      code: "accounting_conflict",
    });
  });
  it("deduplicates concurrent enqueue and canonicalises object key ordering", async () => {
    const input = document();
    const reversed = Object.fromEntries(Object.entries(input).reverse());
    const [first, second] = await Promise.all([
      enqueue(input),
      enqueueAccountingPosting(handle.db, ws, actor, reversed),
    ]);
    expect(second.id).toBe(first.id);
    expect((await history(first.id)).history.map((e) => e.action)).toEqual(["queued"]);
  });
  it("rejects changed source revisions, mappings and destination companies instead of reposting", async () => {
    const input = document();
    await enqueue(input);
    for (const change of [
      { sourceRevision: 2 },
      { companyId: "another-company" },
      { supplierReference: "SUP002" },
    ])
      await expect(enqueue({ ...input, ...change })).rejects.toMatchObject({ code: "accounting_conflict" });
  });
  it("isolates tenants even for identical source IDs and hides other workspace history", async () => {
    const input = document();
    const row = await enqueue(input);
    expect((await enqueue(input, other)).id).not.toBe(row.id);
    await expect(accountingPostingHistory(handle.db, other, row.id)).rejects.toMatchObject({ status: 404 });
    await expect(claimAccountingPosting(handle.db, other, row.id, actor)).rejects.toMatchObject({
      status: 404,
    });
  });
  it("claims only once across competing workers and preserves uncertainty after a crash", async () => {
    const row = await enqueue();
    const claims = await Promise.all([claim(row.id), claim(row.id)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect((await history(row.id)).posting.state).toBe("unknown");
    await expect(
      retryAccountingPosting(handle.db, ws, row.id, claims.find(Boolean)!.attemptId!, actor, "Timed out"),
    ).rejects.toMatchObject({ code: "accounting_conflict" });
    expect(await claim(row.id)).toBeNull();
  });
  it("commits the attempt before external IO; write-then-timeout cannot post twice", async () => {
    const row = await enqueue();
    let calls = 0;
    const connector: AccountingAdapter = {
      ...binding,
      post: async ({ postingKey }) => {
        calls++;
        expect((await history(postingKey)).posting.state).toBe("unknown");
        throw new Error("secret=do-not-store");
      },
    };
    expect((await dispatchAccountingPosting(handle.db, ws, row.id, actor, connector))?.state).toBe("unknown");
    expect(await dispatchAccountingPosting(handle.db, ws, row.id, actor, connector)).toBeNull();
    expect(calls).toBe(1);
    expect(JSON.stringify((await history(row.id)).history)).not.toContain("do-not-store");
  });
  it("retains a definitive rejection, then retries with the same posting key and a new attempt", async () => {
    const row = await enqueue();
    const rejected = await dispatchAccountingPosting(handle.db, ws, row.id, actor, {
      ...binding,
      post: async () => ({ outcome: "rejected", evidence: "ledger validation refused before write" }),
    });
    expect(rejected?.state).toBe("failed");
    await retryAccountingPosting(
      handle.db,
      ws,
      row.id,
      rejected!.attemptId!,
      actor,
      "Account enabled in ledger; retry reviewed",
    );
    const next = await claim(row.id);
    expect(next?.id).toBe(row.id);
    expect(next?.attemptId).not.toBe(rejected!.attemptId);
    expect(next?.attempts).toBe(2);
    await expect(
      recordAccountingOutcome(
        handle.db,
        ws,
        row.id,
        rejected!.attemptId!,
        actor,
        "rejected",
        "Stale callback",
      ),
    ).rejects.toMatchObject({ code: "accounting_conflict" });
    await expect(
      retryAccountingPosting(handle.db, ws, row.id, rejected!.attemptId!, actor, "Stale retry"),
    ).rejects.toMatchObject({ code: "accounting_conflict" });
  });
  it("requires matching read-back and retains idempotent confirmation", async () => {
    const row = await enqueue();
    const attempt = (await claim(row.id))!.attemptId!;
    const readBack = receipt(row.id);
    for (const change of [
      { companyId: "wrong" },
      { postingKey: newId() },
      { net: "10.01", gross: "12.01" },
      { net: "10.01", tax: "1.99" },
      { provider: "another_ledger" },
      { connectionId: newId() },
      { currency: "USD" },
    ])
      await expect(
        confirmAccountingPosting(
          handle.db,
          ws,
          row.id,
          attempt,
          actor,
          { ...readBack, ...change },
          "Read-back",
        ),
      ).rejects.toMatchObject({ code: "accounting_conflict" });
    expect(
      (
        await confirmAccountingPosting(
          handle.db,
          ws,
          row.id,
          attempt,
          actor,
          readBack,
          "ledger transaction independently read back",
        )
      ).state,
    ).toBe("posted");
    expect(
      (await confirmAccountingPosting(handle.db, ws, row.id, attempt, actor, readBack, "Replay")).state,
    ).toBe("posted");
    expect((await history(row.id)).history.filter((e) => e.action === "reconciled")).toHaveLength(1);
    await expect(
      confirmAccountingPosting(
        handle.db,
        ws,
        row.id,
        attempt,
        actor,
        receipt(row.id),
        "Different transaction",
      ),
    ).rejects.toMatchObject({ code: "accounting_conflict" });
    await expect(
      recordAccountingOutcome(handle.db, ws, row.id, attempt, actor, "rejected", "Late rejection"),
    ).rejects.toMatchObject({ code: "accounting_conflict" });
  });
  it("does not assign one ledger transaction to two invoices", async () => {
    const a = await enqueue();
    const b = await enqueue();
    const aa = (await claim(a.id))!.attemptId!,
      bb = (await claim(b.id))!.attemptId!;
    const r = receipt(a.id);
    await confirmAccountingPosting(handle.db, ws, a.id, aa, actor, r, "Read-back");
    await expect(
      confirmAccountingPosting(handle.db, ws, b.id, bb, actor, { ...r, postingKey: b.id }, "Wrong reuse"),
    ).rejects.toMatchObject({ code: "accounting_conflict" });
    expect((await history(b.id)).posting.state).toBe("unknown");
  });
  it("settles a successful connector read-back without sending again", async () => {
    const row = await enqueue();
    const connector: AccountingAdapter = {
      ...binding,
      post: async ({ postingKey }) => ({ outcome: "posted", receipt: receipt(postingKey) }),
    };
    expect((await dispatchAccountingPosting(handle.db, ws, row.id, actor, connector))?.state).toBe("posted");
    expect(await dispatchAccountingPosting(handle.db, ws, row.id, actor, connector)).toBeNull();
  });
  it("keeps malformed connector acknowledgements uncertain", async () => {
    const row = await enqueue();
    await expect(
      dispatchAccountingPosting(handle.db, ws, row.id, actor, {
        ...binding,
        post: async () => ({ outcome: "posted", receipt: receipt(row.id, { companyId: "wrong-company" }) }),
      }),
    ).rejects.toMatchObject({ code: "accounting_conflict" });
    expect((await history(row.id)).posting.state).toBe("unknown");
  });
  it("rolls back a mutation without audit evidence and publishes no private finance data to sync", async () => {
    const row = await enqueue();
    await expect(claimAccountingPosting(handle.db, ws, row.id, "")).rejects.toThrow();
    expect((await history(row.id)).posting.state).toBe("queued");
    expect(await handle.db.select().from(syncChanges).where(eq(syncChanges.workspaceId, ws))).toEqual([]);
    expect((await handle.db.select().from(accountingPostings)).length).toBeGreaterThan(0);
    expect((await handle.db.select().from(accountingPostingEvents)).length).toBeGreaterThan(0);
  });
});
