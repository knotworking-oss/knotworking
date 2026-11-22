import { addDays, newId } from "@knotworking/core";
import { reconcileStockBalances } from "@knotworking/db";
import type { World, Persona } from "./world";
import type { Master, Ingredient } from "./setup";
import type { Rng } from "./rng";
import { prepareDespatch } from "../../src/despatch-test-helpers";

const base = (qty: number, unit: string) => (unit === "kg" ? Math.round(qty * 1000) : qty);

interface OpenPO {
  id: string;
  supplierId: string;
  expectedOn: string;
  lines: { lineId: string; itemId: string; qty: number; unit: string }[];
  sentOn: string;
}
interface OpenOrder {
  id: string;
  customerId: string;
  ref: string;
  lines: { lineId: string; productId: string; qty: number; dueOn: string; shipped: number }[];
}

export class Plant {
  /** Independent model of stock on hand, in base units (g or each), per item. Compared with the server weekly. */
  model = new Map<string, number>();
  openPOs: OpenPO[] = [];
  openOrders: OpenOrder[] = [];
  allOrders: OpenOrder[] = [];
  perWeek = new Map<string, number>(); // batches per week per product
  usage: { day: string; itemId: string; base: number }[] = [];
  stats: Record<string, number> = {};
  batchLog: {
    batchId: string;
    productId: string;
    outputLotId?: string;
    consumedLotIds: string[];
    day: string;
  }[] = [];
  despatchLog: { despatchId: string; customerId: string; lotIds: string[]; day: string }[] = [];
  constructor(
    private w: World,
    private m: Master,
    private rng: Rng,
  ) {
    for (const p of m.products) this.perWeek.set(p.id, rng.int(2, 6));
  }
  private bump(k: string, n = 1) {
    this.stats[k] = (this.stats[k] ?? 0) + n;
  }
  private adj(itemId: string, delta: number) {
    this.model.set(itemId, (this.model.get(itemId) ?? 0) + delta);
  }
  private p(key: string): Persona {
    return this.w.people.get(key)!;
  }
  private all = () => [...this.m.ingredients, ...this.m.packaging];

  // ── Purchasing ──────────────────────────────────────────────────────────
  weeklyNeedBase(item: Ingredient) {
    let need = 0;
    for (const prod of this.m.products) {
      const line = prod.lines.find((l) => l.itemId === item.id);
      if (line) need += (this.perWeek.get(prod.id) ?? 0) * base(line.quantity, line.unit);
    }
    return need;
  }

  weeklyUsage(item: Ingredient, today: string) {
    const since = addDays(today, -14);
    const used = this.usage
      .filter((u) => u.itemId === item.id && u.day > since)
      .reduce((s, u) => s + u.base, 0);
    const observed = used / 2;
    return Math.max(observed, this.weeklyNeedBase(item) * 0.5);
  }

  async raiseOrders(today: string, share: number, leadDays: number) {
    const buyer = this.rng.chance(0.5) ? this.p("buyer") : this.p("buyMgr");
    const packSupplier = this.m.suppliers[5]!;
    const bySupplier = new Map<string, { itemId: string; qty: number; unit: string; price: number }[]>();
    for (const item of this.all()) {
      const weekly = this.weeklyUsage(item, today);
      const cover = item.shelfDays < 15 ? 0.6 : 1.4; // perishables: little and often
      const target = weekly * cover * (share >= 2 ? 1 : 1) + weekly * 0.25;
      const onOrder = this.openPOs
        .flatMap((po) => po.lines)
        .filter((l) => l.itemId === item.id)
        .reduce((s, l) => s + base(l.qty, l.unit), 0);
      const short = target - ((this.model.get(item.id) ?? 0) + onOrder);
      if (short <= 0) continue;
      const sup =
        item.unit === "each"
          ? packSupplier
          : (this.m.suppliers.find((s) => s.supplies.includes(item.id)) ?? this.m.suppliers[0]!);
      const qty = item.unit === "kg" ? Math.max(1, Math.ceil(short / 1000)) : Math.ceil(short / 50) * 50;
      const list = bySupplier.get(sup.id) ?? [];
      list.push({
        itemId: item.id,
        qty,
        unit: item.unit,
        price: this.rng.round(
          item.unit === "kg" ? this.rng.next() * 4 + 0.5 : 0.05 + this.rng.next() * 0.2,
          3,
        ),
      });
      bySupplier.set(sup.id, list);
    }
    for (const [supplierId, lines] of bySupplier) {
      const expectedOn = addDays(today, leadDays);
      const r = await this.w.call(
        buyer,
        "POST",
        "/purchasing/orders",
        {
          supplierId,
          expectedOn,
          deliveryLocationId: this.m.locations.dry,
          lines: lines.map((l) => ({ itemId: l.itemId, quantity: l.qty, unit: l.unit, unitPrice: l.price })),
        },
        [201],
      );
      if (!r.body?.id) continue;
      const sent = await this.w.call(
        this.p("buyMgr"),
        "POST",
        `/purchasing/orders/${r.body.id}/send`,
        {},
        [200],
      );
      if (!sent.ok) continue;
      this.bump("po_sent");
      this.openPOs.push({
        id: r.body.id,
        supplierId,
        expectedOn,
        sentOn: today,
        lines: (r.body.lines as any[]).map((l) => ({
          lineId: l.id,
          itemId: l.itemId ?? l.item?.id,
          qty: lines.find((x) => x.itemId === (l.itemId ?? l.item?.id))!.qty,
          unit: l.unit ?? lines.find((x) => x.itemId === (l.itemId ?? l.item?.id))?.unit,
        })),
      });
    }
  }

  async goodsIn(today: string) {
    const due = this.openPOs.filter((po) => po.expectedOn <= today);
    for (const po of due) {
      const gi = this.rng.chance(0.5) ? this.p("goodsIn1") : this.p("goodsIn2");
      const lines: any[] = [];
      const accepted: { itemId: string; base: number }[] = [];
      for (const l of po.lines) {
        const item = this.all().find((i) => i.id === l.itemId)!;
        const r = this.rng.next();
        const loc =
          item.unit === "each"
            ? this.m.locations.dry
            : item.code.startsWith("CHK") ||
                item.code.startsWith("MLK") ||
                item.code.startsWith("EGG") ||
                item.code.startsWith("BUT") ||
                item.code.startsWith("CRM") ||
                item.code.startsWith("BCN") ||
                item.code.startsWith("CHE")
              ? this.m.locations.chill
              : this.m.locations.dry;
        if (r < 0.03) {
          lines.push({
            lineId: l.lineId,
            outcome: "rejected",
            quantity: l.qty,
            unit: l.unit,
            reason: "Temperature out of range on arrival",
          });
          this.bump("receipt_rejected");
          continue;
        }
        let qty = l.qty;
        if (r < 0.13) qty = Math.max(0.001, Math.round(l.qty * (0.7 + this.rng.next() * 0.25) * 1000) / 1000);
        if (item.unit === "each") qty = Math.max(1, Math.floor(qty));
        const life = Math.max(3, Math.floor(item.shelfDays * (0.6 + this.rng.next() * 0.3)));
        lines.push({
          lineId: l.lineId,
          outcome: "accepted",
          quantity: qty,
          unit: l.unit,
          locationId: loc,
          supplierLotCode: `S${this.rng.int(10000, 99999)}`,
          expiresOn: addDays(today, life),
          expiryType: item.shelfDays < 30 ? "use_by" : "best_before",
          ...(this.rng.chance(0.15) ? { status: "quarantine" } : {}),
        });
        accepted.push({ itemId: l.itemId, base: base(qty, l.unit) });
      }
      const res = await this.w.call(
        gi,
        "POST",
        `/purchasing/orders/${po.id}/receipts`,
        { receivedOn: today, deliveryReference: `DN-${this.rng.int(1000, 9999)}`, lines },
        [201],
      );
      if (res.ok) {
        for (const a of accepted) this.adj(a.itemId, a.base);
        this.bump("receipts");
        // Short deliveries stay open for a few days, then are closed short.
        const fresh = await this.w.call(gi, "GET", `/purchasing/orders/${po.id}`);
        const st = fresh.body?.status;
        if (st === "received" || st === "closed" || st === "complete")
          this.openPOs = this.openPOs.filter((x) => x.id !== po.id);
        else if (today > addDays(po.expectedOn, 3)) {
          const c = await this.w.call(
            this.p("buyMgr"),
            "POST",
            `/purchasing/orders/${po.id}/close`,
            { reason: "Supplier short-shipped; balance no longer required" },
            [200],
          );
          if (c.ok) {
            this.openPOs = this.openPOs.filter((x) => x.id !== po.id);
            this.bump("po_closed_short");
          }
        } else po.lines = po.lines.map((l) => l);
      } else this.openPOs = this.openPOs.filter((x) => x.id !== po.id);
    }
  }

  // ── Stock helpers ───────────────────────────────────────────────────────
  async lotsFor(itemId: string, status = "available") {
    const r = await this.w.call(
      this.p("prodMgr"),
      "GET",
      `/stock/lots?itemId=${itemId}&status=${status}&limit=200`,
    );
    const lots: any[] = (r.body?.lots ?? []).filter((l: any) => l.onHand.base > 0);
    return lots.sort((a, b) => (a.expiresOn ?? "9999").localeCompare(b.expiresOn ?? "9999"));
  }

  async qaRelease(today: string) {
    const qa = this.p("qaTech");
    const r = await this.w.call(qa, "GET", `/stock/lots?status=quarantine&limit=200`);
    for (const lot of (r.body?.lots ?? []) as any[]) {
      if (lot.onHand.base <= 0) continue;
      const fail = this.rng.chance(0.03);
      const res = await this.w.call(
        this.p("qaMgr"),
        "POST",
        `/stock/lots/${lot.id}/status`,
        {
          status: fail ? "rejected" : "available",
          note: fail ? "Failed QA check on sensory evaluation" : "Checks passed",
        },
        [200, 409],
      );
      this.bump(res.ok ? (fail ? "lots_rejected" : "lots_released") : "lot_release_blocked");
    }
  }

  async wasteExpired(today: string) {
    const r = await this.w.call(this.p("qaMgr"), "GET", `/stock/lots?limit=200&expiry=expired`);
    for (const lot of (r.body?.lots ?? []) as any[]) {
      if (!lot.expiresOn || lot.expiresOn >= today || lot.onHand.base <= 0) continue;
      for (const b of lot.balances ?? []) {
        if (b.amount.base <= 0) continue;
        const unit = lot.item.unit === "kg" ? "g" : lot.item.unit;
        const res = await this.w.call(
          this.p("qaMgr"),
          "POST",
          "/stock/waste",
          {
            lotId: lot.id,
            locationId: b.locationId,
            quantity: b.amount.base,
            unit,
            reason: "Past use-by/best-before date",
          },
          [200, 201],
        );
        if (res.ok) {
          this.adj(lot.itemId, -b.amount.base);
          this.bump("waste_expired");
        }
      }
    }
  }

  // ── Sales ───────────────────────────────────────────────────────────────
  async takeOrders(today: string) {
    const n = this.rng.int(5, 10);
    for (let i = 0; i < n; i++) {
      const rep = this.rng.chance(0.5) ? this.p("rep1") : this.p("rep2");
      const customer = this.rng.pick(this.m.customers);
      const picks = [...this.m.products].sort(() => this.rng.next() - 0.5).slice(0, this.rng.int(1, 3));
      const lines = picks.map((pr) => {
        const weekly = (this.perWeek.get(pr.id) ?? 3) * pr.batchYield;
        const qty = Math.max(6, Math.round(weekly / 8 / 6) * 6);
        return {
          itemId: pr.id,
          quantity: qty,
          unit: "each",
          dueOn: addDays(today, this.rng.int(1, 4)),
          unitPrice: this.rng.round(1.2 + this.rng.next() * 4, 2),
        };
      });
      const c = await this.w.call(
        rep,
        "POST",
        "/sales/orders",
        {
          commandId: newId(),
          kind: "order",
          document: {
            customerId: customer.id,
            currency: "GBP",
            terms: "Net 30",
            customerReference: `PO${this.rng.int(10000, 99999)}`,
            lines,
          },
        },
        [201],
      );
      if (!c.body?.id) continue;
      const k = await this.w.call(
        this.p("salesMgr"),
        "POST",
        `/sales/orders/${c.body.id}/confirm`,
        {
          commandId: newId(),
          expectedRevision: c.body.revision,
          reason: "Credit and stock position checked",
        },
        [200],
      );
      if (!k.ok) continue;
      this.bump("orders_confirmed");
      const entry: OpenOrder = {
        id: c.body.id,
        customerId: customer.id,
        ref: c.body.reference ?? c.body.id,
        lines: (k.body.lines as any[]).map((l) => ({
          lineId: l.id,
          productId: l.itemId ?? l.item?.id,
          qty: l.quantity,
          dueOn: l.dueOn,
          shipped: 0,
        })),
      };
      this.openOrders.push(entry);
      this.allOrders.push(entry);
    }
  }

  // ── Production ──────────────────────────────────────────────────────────
  async produce(today: string) {
    const planner = this.p("planner");
    for (const prod of this.m.products) {
      const demand = this.openOrders
        .flatMap((o) => o.lines)
        .filter((l) => l.productId === prod.id && l.dueOn <= addDays(today, 3))
        .reduce((s, l) => s + (l.qty - l.shipped), 0);
      const have = this.model.get(prod.id) ?? 0;
      let batches = Math.ceil((demand - have) / prod.batchYield);
      if (batches <= 0 && have < prod.batchYield * 0.3 && this.rng.chance(0.5)) batches = 1;
      batches = Math.min(batches, 4);
      if (batches <= 0) continue;
      const op = this.p(this.rng.pick(["op1", "op2", "op3"]));
      const b = await this.w.call(
        planner,
        "POST",
        "/production/batches",
        { recipeId: prod.recipeId, plannedOn: today, batches, outputLocationId: this.m.locations.finished },
        [201],
      );
      if (!b.body?.id) continue;
      this.bump("batches_planned");
      const started = await this.w.call(
        op,
        "POST",
        `/production/batches/${b.body.id}/start`,
        undefined,
        [200],
      );
      if (!started.ok) continue;
      // Draw each ingredient FEFO from available lots.
      const lines: any[] = [];
      const draws: { itemId: string; base: number }[] = [];
      let short = false;
      for (const rl of prod.lines) {
        let need = base(rl.quantity, rl.unit) * batches;
        const lots = await this.lotsFor(rl.itemId);
        for (const lot of lots) {
          if (need <= 0) break;
          if (lot.expiresOn && lot.expiresOn < today) continue;
          for (const bal of lot.balances) {
            if (need <= 0) break;
            const take = Math.min(need, bal.amount.base);
            if (take <= 0) continue;
            lines.push({
              lotId: lot.id,
              locationId: bal.locationId,
              quantity: take,
              unit: rl.unit === "kg" ? "g" : rl.unit,
            });
            draws.push({ itemId: rl.itemId, base: take });
            need -= take;
          }
        }
        if (need > 0) short = true;
      }
      if (short) {
        this.bump("batch_cancelled_shortage");
        await this.w.call(
          this.p("prodMgr"),
          "POST",
          `/production/batches/${b.body.id}/cancel`,
          { reason: "Insufficient ingredient stock" },
          [200],
        );
        continue;
      }
      const cons = await this.w.call(
        op,
        "POST",
        `/production/batches/${b.body.id}/consumption`,
        { lines },
        [201],
      );
      if (!cons.ok) {
        await this.w.call(
          this.p("prodMgr"),
          "POST",
          `/production/batches/${b.body.id}/cancel`,
          { reason: "Consumption failed" },
          [200, 409],
        );
        continue;
      }
      for (const d of draws) {
        this.adj(d.itemId, -d.base);
        this.usage.push({ day: today, itemId: d.itemId, base: d.base });
      }
      const out = Math.floor(prod.batchYield * batches * (0.95 + this.rng.next() * 0.05));
      const o = await this.w.call(
        op,
        "POST",
        `/production/batches/${b.body.id}/output`,
        { quantity: out, unit: "each" },
        [201],
      );
      if (!o.ok) continue;
      this.adj(prod.id, out);
      this.batchLog.push({
        batchId: b.body.id,
        productId: prod.id,
        outputLotId: o.body?.outputs?.[0]?.lotId,
        consumedLotIds: [...new Set<string>(lines.map((l) => l.lotId))],
        day: today,
      });
      const done = await this.w.call(
        this.p("prodMgr"),
        "POST",
        `/production/batches/${b.body.id}/complete`,
        { note: "Batch record checked" },
        [200],
      );
      if (done.ok) this.bump("batches_completed");
    }
  }

  // ── Despatch ────────────────────────────────────────────────────────────
  async despatch(today: string) {
    const desp = this.p(this.rng.chance(0.5) ? "desp1" : "desp2");
    const due = this.openOrders.filter((o) =>
      o.lines.some((l) => l.dueOn <= addDays(today, 1) && l.qty > l.shipped),
    );
    for (const order of due) {
      const lines: any[] = [];
      const picked: { line: OpenOrder["lines"][number]; qty: number; lotId: string }[] = [];
      for (const ol of order.lines) {
        const outstanding = ol.qty - ol.shipped;
        if (outstanding <= 0 || ol.dueOn > addDays(today, 1)) continue;
        let need = outstanding;
        for (const lot of await this.lotsFor(ol.productId)) {
          if (need <= 0) break;
          if (lot.expiresOn && lot.expiresOn <= addDays(today, 1)) continue;
          for (const bal of lot.balances) {
            const take = Math.min(need, bal.amount.base);
            if (take <= 0) continue;
            lines.push({ lotId: lot.id, locationId: bal.locationId, quantity: take, unit: "each" });
            picked.push({ line: ol, qty: take, lotId: lot.id });
            need -= take;
            if (need <= 0) break;
          }
        }
      }
      if (!lines.length) {
        this.bump("despatch_no_stock");
        continue;
      }
      const d = await this.w.call(
        desp,
        "POST",
        "/despatch",
        { customerId: order.customerId, despatchedOn: today, externalReference: order.ref, lines },
        [201],
      );
      if (!d.body?.id) continue;
      const call = async (method: string, path: string, json?: unknown) => {
        const r = await this.w.call(desp, method, path, json, [200, 201]);
        return { ok: r.ok, status: r.status, json: async () => r.body } as any;
      };
      const prepared = await prepareDespatch(call, d.body.id, d.body.updatedAt);
      if (prepared.error) continue;
      const conf = await this.w.call(
        this.p("desp1"),
        "POST",
        `/despatch/${d.body.id}/confirm`,
        { commandId: newId(), expectedUpdatedAt: prepared.stamp },
        [200],
      );
      if (!conf.ok) continue;
      this.bump("despatches");
      this.despatchLog.push({
        despatchId: d.body.id,
        customerId: order.customerId,
        lotIds: [...new Set<string>(lines.map((l) => l.lotId))],
        day: today,
      });
      const shipped = new Map<string, number>();
      for (const pk of picked) {
        this.adj(pk.line.productId, -pk.qty);
        shipped.set(pk.line.lineId, (shipped.get(pk.line.lineId) ?? 0) + pk.qty);
      }
      // Link the shipment back to the order lines (one link per despatch line).
      let sales = await this.w.call(this.p("salesMgr"), "GET", `/sales/orders/${order.id}`);
      for (const dl of (conf.body.lines ?? []) as any[]) {
        const pk =
          picked.find(
            (x) =>
              x.lotId === dl.lotId &&
              Math.abs(base(dl.amount?.display ?? 0, dl.amount?.displayUnit ?? "each") - x.qty) < 1,
          ) ?? picked.find((x) => x.lotId === dl.lotId);
        if (!pk) continue;
        const f = await this.w.call(
          this.p("salesMgr"),
          "POST",
          `/sales/orders/${order.id}/fulfilments`,
          {
            commandId: newId(),
            expectedRevision: sales.body.revision,
            orderLineId: pk.line.lineId,
            despatchLineId: dl.id,
            reason: "Shipped against order",
          },
          [200, 201],
        );
        if (f.ok) sales = { ...sales, body: f.body };
      }
      for (const ol of order.lines) ol.shipped += shipped.get(ol.lineId) ?? 0;
      if (order.lines.every((l) => l.qty - l.shipped <= 0))
        this.openOrders = this.openOrders.filter((o) => o.id !== order.id);
    }
  }

  // ── Invariants ──────────────────────────────────────────────────────────
  async checkInvariants(day: string) {
    const f = this.w.findings;
    const lv = await this.w.call(this.p("md"), "GET", "/stock/levels?limit=200");
    const levels: any[] = lv.body?.levels ?? [];
    for (const l of levels) {
      const expected = this.model.get(l.item.id) ?? 0;
      if (Math.abs(l.onHand.base - expected) > 1)
        f.record({
          kind: "invariant",
          day,
          who: "model",
          what: `stock level differs from independent model for ${l.item.code}`,
          detail: { server: l.onHand.base, model: expected },
        });
      if (l.onHand.base < 0)
        f.record({
          kind: "invariant",
          day,
          who: "model",
          what: `negative on-hand for ${l.item.code}`,
          detail: l.onHand,
        });
      const sum = l.available.base + l.quarantine.base + l.rejected.base;
      if (Math.abs(sum - l.onHand.base) > 1)
        f.record({
          kind: "invariant",
          day,
          who: "model",
          what: `available+quarantine+rejected != onHand for ${l.item.code}`,
          detail: { sum, onHand: l.onHand.base },
        });
    }
    // The stored balances must equal the ledger they summarise.
    const drift = await reconcileStockBalances(this.w.ctx.handle.db);
    if (drift.length)
      f.record({
        kind: "invariant",
        day,
        who: "model",
        what: "stock_balances differs from the stock ledger",
        detail: { rows: drift.length, first: drift[0] },
      });
    const lots = await this.w.call(this.p("md"), "GET", "/stock/lots?limit=200");
    for (const lot of (lots.body?.lots ?? []) as any[]) {
      const sum = (lot.balances ?? []).reduce((s: number, b: any) => s + b.amount.base, 0);
      if (Math.abs(sum - lot.onHand.base) > 1)
        f.record({
          kind: "invariant",
          day,
          who: "model",
          what: "lot onHand != sum of location balances",
          detail: { lot: lot.lotCode, sum, onHand: lot.onHand.base },
        });
      if (lot.balances?.some((b: any) => b.amount.base < 0))
        f.record({
          kind: "invariant",
          day,
          who: "model",
          what: "negative location balance",
          detail: { lot: lot.lotCode },
        });
    }
  }
}
