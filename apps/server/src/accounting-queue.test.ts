import { DEFAULT_TIME_ZONE, newId, todayInZone, type AccountingReceipt } from "@knotworking/core";
import { accountingPostingEvents, accountingPostings, users, workspaces } from "@knotworking/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dispatchQueuedPostings } from "./accounting/dispatcher";
import { allocateAccountingQueueItem } from "./accounting/queue";
import { createAccountingAdapterRegistry, type AccountingAdapterFactory } from "./accounting/registry";
import { makeApp, signIn, type Res, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";
const today = todayInZone(DEFAULT_TIME_ZONE);

/** A fake destination ledger: posts, rejects without writing, or writes and loses the reply. */
const ledger = new Map<string, AccountingReceipt>();
let mode: "post" | "reject" | "lost" = "post";
let calls = 0;
const fakeXero: AccountingAdapterFactory = (binding) => ({
  provider: binding.provider,
  connectionId: binding.connectionId,
  companyId: binding.companyId,
  capabilities: { postingKinds: ["purchase_invoice"], currencies: ["GBP"] },
  async post({ postingKey, document }) {
    calls++;
    if (mode === "reject") return { outcome: "rejected", evidence: "Contact is archived; nothing written" };
    const receipt: AccountingReceipt = {
      provider: binding.provider,
      connectionId: binding.connectionId,
      companyId: binding.companyId,
      postingKey,
      externalId: `TX-${ledger.size + 1}`,
      currency: document.currency,
      net: document.net,
      tax: document.tax,
      gross: document.gross,
    };
    ledger.set(receipt.externalId, receipt);
    if (mode === "lost") throw new Error("socket hang up token=secret-value");
    return { outcome: "posted", receipt };
  },
  async readBack({ postingKey, externalId }) {
    const receipt = ledger.get(externalId);
    return receipt?.postingKey === postingKey ? receipt : null;
  },
});
const registry = createAccountingAdapterRegistry({ xero: fakeXero });

describe("accounting dispatch and the finance review queue", () => {
  let ctx: TestCtx, ada: string, marcus: string, token: string, supplier: string;
  let xero: any, community: any;
  const send = (method: string, path: string, json?: unknown, cookie = ada) =>
    ctx.req(WS + path, { method, json, cookie });
  const ok = async (input: Res | Promise<Res>, status = 200) => {
    const response = await input;
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(status);
    return body;
  };
  const code = async (input: Res | Promise<Res>, status: number) => (await ok(input, status)).error.code;
  const queue = (connection: any, state = "queued") =>
    ok(send("GET", `/accounting/connections/${connection.id}/postings?state=${state}`));
  const item = (connection: any, id: string) =>
    ok(send("GET", `/accounting/connections/${connection.id}/postings/${id}`));
  const action = (connection: any, id: string, name: string, json?: unknown) =>
    send("POST", `/accounting/connections/${connection.id}/postings/${id}/${name}`, json);

  async function connect(provider: string) {
    let connection = await ok(
      send("POST", "/accounting/connections", {
        commandId: newId(),
        provider,
        name: provider,
        companyId: newId(),
      }),
      201,
    );
    for (const [kind, local, external] of [
      ["supplier", supplier, newId()], // a Xero ContactID is a UUID
      ["account", "carriage", "5100"],
      ["tax", "standard", "INPUT2"],
    ]) {
      await ok(
        send("PUT", `/accounting/connections/${connection.id}/mappings`, {
          commandId: newId(),
          expectedRevision: connection.revision,
          kind,
          localReference: local,
          externalReference: external,
          enabled: true,
          reason: "Reviewed",
        }),
      );
      connection = (await ok(send("GET", `/accounting/connections/${connection.id}`))).connection;
    }
    return connection;
  }
  /** Approves a one-line invoice and prepares it for `connection`; returns the posting ID. */
  async function prepared(connection: any, invoiceNumber: string) {
    const draft = await ok(
      send("POST", "/purchasing/invoices", {
        supplierId: supplier,
        invoiceNumber,
        invoiceDate: today,
        dueDate: today,
        vat: 2,
        lines: [{ kind: "charge", description: "Carriage", quantity: 1, unitPrice: 10 }],
      }),
      201,
    );
    const invoice = await ok(send("POST", `/purchasing/invoices/${draft.id}/approve`, { reason: "Agreed" }));
    const posting = await ok(
      send("POST", `/accounting/connections/${connection.id}/purchase-invoices/${invoice.id}/prepare`, {
        commandId: newId(),
        expectedRevision: connection.revision,
        reason: "Reviewed",
        lines: [
          {
            invoiceLineId: invoice.lines[0].id,
            accountKey: "carriage",
            taxKey: "standard",
            description: "Carriage",
            net: "10.00",
            tax: "2.00",
          },
        ],
      }),
      201,
    );
    return posting.id as string;
  }

  beforeAll(async () => {
    ctx = await makeApp({ seed: true, accountingAdapters: registry });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    marcus = (await signIn(ctx, "marcus@knotworking.dev")).cookie;
    token = (
      await ok(
        ctx.req("/v1/me/api-tokens", {
          method: "POST",
          cookie: ada,
          json: { name: "agent", scope: "write" },
        }),
        201,
      )
    ).token;
    supplier = (await ok(send("POST", "/suppliers", { name: "Haulier" }), 201)).id;
    await ok(send("POST", `/suppliers/${supplier}/approval`, { status: "approved" }));
    xero = await connect("xero");
    community = await connect("community_ledger");
  }, 120_000);
  afterAll(() => ctx?.handle.close());

  it("dispatches queued postings through the installed adapter and records the ledger read-back", async () => {
    const id = await prepared(xero, "Q-1");
    const listed = await queue(xero);
    expect(listed).toMatchObject({ adapterInstalled: true, canReadBack: true, counts: { queued: 1 } });
    expect(listed.postings[0]).toMatchObject({ id, reference: "Q-1", gross: "12.00", state: "queued" });
    try {
      await ok(send("PATCH", "/module-settings", { modules: ["tasks", "docs"] }));
      expect((await dispatchQueuedPostings(ctx.handle.db, registry)).posted).toBe(0);
    } finally {
      await ok(send("PATCH", "/module-settings", { modules: null }));
    }
    const switchOffAfterScan = createAccountingAdapterRegistry({
      async xero(binding) {
        await ok(send("PATCH", "/module-settings", { modules: ["tasks", "docs"] }));
        return fakeXero(binding);
      },
    });
    const before = calls;
    try {
      expect((await dispatchQueuedPostings(ctx.handle.db, switchOffAfterScan)).posted).toBe(0);
      expect(calls).toBe(before);
    } finally {
      await ok(send("PATCH", "/module-settings", { modules: null }));
    }
    expect((await item(xero, id)).posting).toMatchObject({ state: "queued", attempts: 0, attemptId: null });
    expect(await dispatchQueuedPostings(ctx.handle.db, registry)).toEqual({
      posted: 1,
      failed: 0,
      unknown: 0,
      skipped: 0,
      deferred: 0,
    });
    const detail = await item(xero, id);
    expect(detail.posting).toMatchObject({ state: "posted", externalId: "TX-1" });
    expect(detail.history.map((h: any) => [h.action, h.actor])).toEqual([
      ["queued", "Ada Park"],
      ["dispatch_started", "Automatic dispatch"],
      ["reconciled", "Automatic dispatch"],
    ]);
    expect((await queue(xero, "posted")).counts).toMatchObject({ queued: 0, posted: 1 });
  });

  it("retries only the current definitive rejection, keeping the same snapshot", async () => {
    mode = "reject";
    const id = await prepared(xero, "Q-2");
    expect((await dispatchQueuedPostings(ctx.handle.db, registry)).failed).toBe(1);
    const failed = await item(xero, id);
    expect(failed.posting.state).toBe("failed");
    expect(failed.history.at(-1).evidence).toContain("nothing written");
    expect(await code(action(xero, id, "retry", { attemptId: newId(), reason: "Fixed" }), 409)).toBe(
      "accounting_conflict",
    );
    const { attemptId } = failed.posting;
    expect(
      (await ok(action(xero, id, "retry", { attemptId, reason: "Contact restored" }))).posting.state,
    ).toBe("queued");
    expect(await code(action(xero, id, "retry", { attemptId, reason: "Again" }), 409)).toBe(
      "accounting_conflict",
    );
    mode = "post";
    const sent = await ok(action(xero, id, "send"));
    expect(sent.posting).toMatchObject({ state: "posted", attempts: 2 });
    expect(sent.history.map((h: any) => h.action)).toEqual([
      "queued",
      "dispatch_started",
      "rejected",
      "retry_requested",
      "dispatch_started",
      "reconciled",
    ]);
    expect(await code(action(xero, id, "send"), 409)).toBe("posting_not_queued");
  });

  it("never resends an uncertain posting, and settles it only by positive read-back", async () => {
    mode = "lost";
    const id = await prepared(xero, "Q-3");
    expect((await dispatchQueuedPostings(ctx.handle.db, registry)).unknown).toBe(1);
    mode = "post";
    const uncertain = await item(xero, id);
    expect(uncertain.posting.state).toBe("unknown");
    expect(JSON.stringify(uncertain.history)).not.toContain("secret-value");
    const before = calls;
    await dispatchQueuedPostings(ctx.handle.db, registry);
    expect(await code(action(xero, id, "send"), 409)).toBe("posting_not_queued");
    expect(calls).toBe(before);
    const { attemptId } = uncertain.posting;
    const written = [...ledger.values()].find((r) => r.postingKey === id)!.externalId;
    // Another posting's transaction, or none, does not settle it.
    expect(
      await code(action(xero, id, "read-back", { attemptId, externalId: "TX-1", reason: "Found" }), 409),
    ).toBe("read_back_not_verified");
    expect(
      await code(action(xero, id, "read-back", { attemptId, externalId: "TX-404", reason: "Found" }), 409),
    ).toBe("read_back_not_verified");
    expect((await item(xero, id)).posting.state).toBe("unknown");
    expect(await code(action(xero, id, "retry", { attemptId, reason: "Resend" }), 409)).toBe(
      "accounting_conflict",
    );
    const settled = await ok(
      action(xero, id, "read-back", { attemptId, externalId: written, reason: "Found in Xero bills" }),
    );
    expect(settled.posting).toMatchObject({ state: "posted", externalId: written });
    expect(settled.history.at(-1)).toMatchObject({ action: "reconciled", actor: "Ada Park" });
    expect(settled.history.at(-1).evidence).toContain("Found in Xero bills");
    expect(
      await code(action(xero, id, "read-back", { attemptId, externalId: written, reason: "Again" }), 409),
    ).toBe("accounting_conflict");
  });

  it("leaves postings queued without an installed adapter or on a disabled connection", async () => {
    const id = await prepared(community, "Q-4");
    expect(await queue(community)).toMatchObject({ adapterInstalled: false, canReadBack: false });
    expect((await dispatchQueuedPostings(ctx.handle.db, registry)).posted).toBe(0);
    expect(await code(action(community, id, "send"), 409)).toBe("adapter_not_installed");
    expect((await item(community, id)).posting.state).toBe("queued");

    const waiting = await prepared(xero, "Q-5");
    await ok(
      send("PATCH", `/accounting/connections/${xero.id}`, {
        commandId: newId(),
        expectedRevision: xero.revision,
        name: xero.name,
        disabled: true,
        companyId: xero.companyId,
        reason: "Paused for year end",
      }),
    );
    expect(await queue(xero)).toMatchObject({ adapterInstalled: false });
    expect((await dispatchQueuedPostings(ctx.handle.db, registry)).posted).toBe(0);
    expect(await code(action(xero, waiting, "send"), 409)).toBe("accounting_conflict");
    expect((await item(xero, waiting)).posting.state).toBe("queued");
    // A posting belongs to its own connection.
    expect((await send("GET", `/accounting/connections/${community.id}/postings/${waiting}`)).status).toBe(
      404,
    );
  });

  it("takes connections in turn, so a stuck connection doesn't starve the others", async () => {
    const lapsed = await connect("xero");
    const broken = await connect("xero");
    const healthy = await connect("xero");
    const stuck = [
      await prepared(lapsed, "RR-1"),
      await prepared(lapsed, "RR-2"),
      await prepared(broken, "RR-3"),
      await prepared(broken, "RR-4"),
    ];
    const fresh = await prepared(healthy, "RR-5");
    const uneven = createAccountingAdapterRegistry({
      async xero(binding) {
        if (binding.connectionId === broken.id) throw new Error("APP_URL must not have a path");
        const adapter = (await fakeXero(binding))!;
        if (binding.connectionId !== lapsed.id) return adapter;
        return {
          ...adapter,
          async post() {
            return { outcome: "deferred" as const, evidence: "Reconnect to Xero" };
          },
        };
      },
    });
    const log = { error() {} };
    // Oldest first across the installation would spend this pass on the lapsed and broken
    // connections' postings and never reach the healthy one.
    expect(await dispatchQueuedPostings(ctx.handle.db, uneven, { limit: 3, log })).toEqual({
      posted: 1,
      failed: 0,
      unknown: 0,
      skipped: 1,
      deferred: 1,
    });
    expect((await item(healthy, fresh)).posting.state).toBe("posted");
    for (const [connection, id] of [
      [lapsed, stuck[0]],
      [lapsed, stuck[1]],
      [broken, stuck[2]],
      [broken, stuck[3]],
    ])
      expect((await item(connection, id!)).posting).toMatchObject({ state: "queued" });
  });

  it("claims a pending allocation before calling the ledger, so two requests don't both allocate", async () => {
    const connection = await connect("xero");
    const id = await prepared(connection, "AL-1");
    await ok(action(connection, id, "send"));
    const { db } = ctx.handle;
    await db.update(accountingPostings).set({ allocation: "pending" }).where(eq(accountingPostings.id, id));
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.slug, "acme"));
    const [actor] = await db.select().from(users).where(eq(users.email, "ada@knotworking.dev"));
    let allocations = 0;
    let verdict = false;
    let release!: () => void;
    const gate = () => new Promise<void>((resolve) => (release = resolve));
    let opened = gate();
    const allocating = createAccountingAdapterRegistry({
      xero: (binding) => ({
        ...fakeXero(binding)!,
        async allocate() {
          allocations++;
          await opened;
          return { allocated: verdict, evidence: verdict ? "Allocation read back" : "Invoice already paid" };
        },
      }),
    });
    const allocate = (kind: "allocate" | "record" = "allocate") =>
      allocateAccountingQueueItem(db, ws!, connection.id, id, actor!.id, allocating, {
        action: kind,
        reason: "Finance reviewed",
      });
    const refusal = (promise: Promise<unknown>) =>
      promise.then(
        () => null,
        (error: { code?: string }) => error.code,
      );

    // A second request, or recording it by hand, while the first is with the ledger is refused.
    const first = refusal(allocate());
    await vi.waitFor(() => expect(allocations).toBe(1));
    expect(await refusal(allocate())).toBe("allocation_in_progress");
    expect(await refusal(allocate("record"))).toBe("allocation_in_progress");
    release();
    expect(await first).toBe("allocation_not_verified");
    expect(allocations).toBe(1);
    expect((await item(connection, id)).posting.allocation).toBe("pending");

    // The refused outcome ended the claim: the next request goes to the ledger.
    verdict = true;
    opened = Promise.resolve();
    expect((await allocate()).posting.allocation).toBe("allocated");
    expect(allocations).toBe(2);
    expect((await item(connection, id)).history.map((h: any) => h.action).slice(-4)).toEqual([
      "allocation_started",
      "allocation_not_verified",
      "allocation_started",
      "allocation_verified",
    ]);

    // A request that died with the ledger stops holding the allocation once its claim lapses.
    await db.update(accountingPostings).set({ allocation: "pending" }).where(eq(accountingPostings.id, id));
    opened = gate();
    const stalled = refusal(allocate());
    await vi.waitFor(() => expect(allocations).toBe(3));
    await db
      .update(accountingPostingEvents)
      .set({ createdAt: sql`now() - interval '10 minutes'` })
      .where(
        and(
          eq(accountingPostingEvents.postingId, id),
          eq(accountingPostingEvents.action, "allocation_started"),
        ),
      );
    expect((await allocate("record")).posting.allocation).toBe("recorded");
    release();
    expect(await stalled).toBe("accounting_conflict");
  });

  it("is for signed-in administrators only", async () => {
    expect((await send("GET", `/accounting/connections/${xero.id}/postings`, undefined, marcus)).status).toBe(
      403,
    );
    const viaToken = await ctx.req(`${WS}/accounting/connections/${xero.id}/postings`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(viaToken.status).toBe(403);
  });
});

describe("accounting adapter registry", () => {
  const binding = {
    workspaceId: newId(),
    workspaceSlug: "acme",
    currency: "GBP",
    connectionId: newId(),
    provider: "xero",
    companyId: "company-1",
  };
  it("ignores adapters bound to another destination and connections without a company", async () => {
    const other = createAccountingAdapterRegistry({
      xero: (b) => fakeXero({ ...b, connectionId: newId() }) as any,
    });
    expect(await other.resolve(binding)).toBeNull();
    expect(await registry.resolve({ ...binding, companyId: "" })).toBeNull();
    expect(await registry.resolve({ ...binding, provider: "toString" })).toBeNull();
    expect((await registry.resolve(binding))?.connectionId).toBe(binding.connectionId);
  });
});
