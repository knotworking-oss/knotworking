import { addDays, newId } from "@knotworking/core";
import type { World, Persona } from "./world";
import { PASSWORD } from "./world";
import type { Master } from "./setup";
import type { Plant } from "./plant";
import type { Rng } from "./rng";

/** Things that happen over a year and break assumptions: lapsing approvals, leavers, cancellations, price changes, corrections. */
export class Events {
  reviewDue = new Map<string, string>();
  stats: Record<string, number> = {};
  private joiner = 0;
  constructor(
    private w: World,
    private m: Master,
    private rng: Rng,
  ) {}
  private p = (k: string): Persona => this.w.people.get(k)!;
  private bump(k: string, n = 1) {
    this.stats[k] = (this.stats[k] ?? 0) + n;
  }

  /** Give suppliers staggered review dates so some lapse inside the year. */
  async staggerSupplierReviews(start: string) {
    for (const [i, s] of this.m.suppliers.entries()) {
      const due = addDays(start, 60 + i * 45);
      this.reviewDue.set(s.id, due);
      await this.w.call(this.p("qaMgr"), "POST", `/suppliers/${s.id}/approval`, {
        status: "approved",
        reviewDueOn: due,
        note: "Initial approval",
      });
    }
  }

  /** QA renews approvals a week late for a quarter of suppliers (a realistic lapse); the buyer keeps ordering. */
  async supplierReviews(today: string) {
    for (const s of this.m.suppliers) {
      const due = this.reviewDue.get(s.id)!;
      const lateBy = Number(s.id.charCodeAt(s.id.length - 1)) % 4 === 0 ? 7 : 0;
      if (today >= addDays(due, lateBy) && today > due) {
        const next = addDays(today, 365);
        const r = await this.w.call(
          this.p("qaMgr"),
          "POST",
          `/suppliers/${s.id}/approval`,
          { status: "approved", reviewDueOn: next, note: "Annual review completed" },
          [200, 409],
        );
        if (r.ok) {
          this.reviewDue.set(s.id, next);
          this.bump("supplier_reviews");
        }
      }
    }
  }

  /** What does the system do when a PO goes to a supplier whose review is overdue? Recorded, not judged. */
  async lapsedSupplierOrder(today: string) {
    const lapsed = this.m.suppliers.find((s) => this.reviewDue.get(s.id)! < today);
    if (!lapsed) return;
    const item = this.m.ingredients.find((i) => lapsed.supplies.includes(i.id));
    if (!item) return;
    const po = await this.w.call(
      this.p("buyer"),
      "POST",
      "/purchasing/orders",
      {
        supplierId: lapsed.id,
        expectedOn: addDays(today, 3),
        deliveryLocationId: this.m.locations.dry,
        lines: [{ itemId: item.id, quantity: 5, unit: "kg", unitPrice: 1 }],
      },
      [201, 409],
    );
    if (!po.body?.id) {
      this.bump("lapsed_po_create_blocked");
      return;
    }
    const sent = await this.w.call(
      this.p("buyMgr"),
      "POST",
      `/purchasing/orders/${po.body.id}/send`,
      {},
      [200, 409],
    );
    this.bump(sent.status === 200 ? "lapsed_po_sent_without_block" : "lapsed_po_send_blocked");
    await this.w.call(
      this.p("buyMgr"),
      "POST",
      `/purchasing/orders/${po.body.id}/cancel`,
      { reason: "Test order, not required" },
      [200, 409],
    );
  }

  /** Customer price agreements, then orders with no price on the line: the price must be resolved, not left empty. */
  async priceAgreements(today: string) {
    const sales = this.p("salesMgr");
    let n = 0;
    for (const c of this.m.customers.slice(0, 4)) {
      for (const pr of this.m.products.slice(0, 3)) {
        const r = await this.w.call(
          sales,
          "POST",
          "/sales/prices",
          {
            commandId: newId(),
            customerId: c.id,
            itemId: pr.id,
            unit: "each",
            currency: "GBP",
            unitPrice: 2.25,
            validFrom: today,
            validTo: null,
            contractReference: "FY contract",
            terms: "",
          },
          [201],
        );
        if (r.ok) n++;
      }
    }
    this.bump("price_agreements", n);
    const c = this.m.customers[0]!,
      pr = this.m.products[0]!;
    const o = await this.w.call(
      this.p("rep1"),
      "POST",
      "/sales/orders",
      {
        commandId: newId(),
        kind: "order",
        document: {
          customerId: c.id,
          currency: "GBP",
          terms: "Net 30",
          lines: [{ itemId: pr.id, quantity: 12, unit: "each", dueOn: addDays(today, 3) }],
        },
      },
      [201, 400, 409],
    );
    const price = o.body?.lines?.[0]?.unitPrice;
    if (o.ok && (price === null || price === undefined))
      this.w.findings.record({
        kind: "invariant",
        day: today,
        who: "events",
        what: "order line created without a price despite an active customer price agreement",
        detail: o.body?.lines?.[0],
      });
    else if (o.ok && Math.abs(Number(price) - 2.25) > 1e-6)
      this.w.findings.record({
        kind: "invariant",
        day: today,
        who: "events",
        what: "order line resolved a different price than the agreement",
        detail: { price },
      });
    if (o.body?.id)
      await this.w.call(
        this.p("salesMgr"),
        "POST",
        `/sales/orders/${o.body.id}/cancel`,
        { commandId: newId(), expectedRevision: o.body.revision, reason: "Price check order" },
        [200, 409],
      );
  }

  /** A confirmed order is cancelled; a replay of the cancel must be harmless; nothing may ship against it afterwards. */
  async cancelSomeOrders(today: string, plant: Plant) {
    for (const o of [...plant.openOrders]) {
      if (!this.rng.chance(0.04) || o.lines.some((l) => l.shipped > 0)) continue;
      const cur = await this.w.call(this.p("salesMgr"), "GET", `/sales/orders/${o.id}`);
      if (!cur.ok) continue;
      const reason = "Customer cancelled";
      const commandId = newId();
      const r = await this.w.call(
        this.p("salesMgr"),
        "POST",
        `/sales/orders/${o.id}/cancel`,
        { commandId, expectedRevision: cur.body.revision, reason },
        [200, 409],
      );
      if (!r.ok) continue;
      this.bump("orders_cancelled");
      const again = await this.w.call(
        this.p("salesMgr"),
        "POST",
        `/sales/orders/${o.id}/cancel`,
        { commandId, expectedRevision: cur.body.revision, reason },
        [200, 409],
      );
      if (again.status === 200 && again.body?.revision !== r.body?.revision)
        this.w.findings.record({
          kind: "invariant",
          day: today,
          who: "events",
          what: "replayed cancel changed the order revision",
          detail: { first: r.body?.revision, replay: again.body?.revision },
        });
      const ful = await this.w.call(
        this.p("salesMgr"),
        "POST",
        `/sales/orders/${o.id}/fulfilments`,
        {
          commandId: newId(),
          expectedRevision: r.body.revision,
          orderLineId: cur.body.lines[0].id,
          despatchLineId: newId(),
          reason: "post-cancel",
        },
        [400, 404, 409],
      );
      if (ful.status === 200 || ful.status === 201)
        this.w.findings.record({
          kind: "invariant",
          day: today,
          who: "events",
          what: "fulfilment accepted against a cancelled order",
        });
      plant.openOrders = plant.openOrders.filter((x) => x.id !== o.id);
    }
  }

  /** A leaver loses access at once; a joiner is invited, trained and given the same access. */
  async leaverAndJoiner(today: string) {
    const md = this.p("md");
    const leaver = this.rng.pick(["op1", "op2", "rep2", "goodsIn2", "desp2"]);
    const person = this.p(leaver);
    await this.w.call(md, "POST", `/members/${person.userId}/deactivate`, {}, [200, 204]);
    const blocked = await this.w.call(person, "GET", "/stock/levels?limit=1", undefined, [401, 403]);
    if (blocked.status === 200)
      this.w.findings.record({
        kind: "invariant",
        day: today,
        who: "events",
        what: "leaver kept access after deactivation",
      });
    this.bump("leavers");
    // Staff record: end date and status.
    const staff = await this.w.call(this.p("hr"), "GET", "/people/staff?limit=200");
    const rec = (staff.body?.staff ?? staff.body?.items ?? []).find((s: any) => s.userId === person.userId);
    if (rec)
      await this.w.call(
        this.p("hr"),
        "PATCH",
        `/people/staff/${rec.id}`,
        { status: "left", endDate: today },
        [200, 400],
      );
    // Joiner takes the leaver's role.
    const email = `sim.joiner${++this.joiner}@example.test`;
    const inv = await this.w.call(md, "POST", "/invitations", { email, role: "member" });
    const token = inv.body?.url?.split("/invite/")[1];
    if (!token) return;
    await this.w.call(
      md,
      "POST",
      `/v1/public/invitations/${token}/accept`,
      { name: `New Starter ${this.joiner}`, password: PASSWORD },
      [200],
    );
    const members = await this.w.call(md, "GET", "/members");
    const mem = (members.body?.members ?? []).find((x: any) => x.email === email);
    if (!mem) return;
    for (const [mod, level] of Object.entries(person.access))
      await this.w.call(md, "PUT", `/members/${mem.userId}/module-access/${mod}`, { level });
    const joiner: Persona = {
      ...person,
      key: `joiner${this.joiner}`,
      email,
      name: `New Starter ${this.joiner}`,
      userId: mem.userId,
      cookie: "",
      password: PASSWORD,
    };
    this.w.people.set(joiner.key, joiner);
    // The joiner now does the leaver's job: swap the key so the daily routines keep working.
    const old = this.w.people.get(leaver)!;
    this.w.people.set(`left_${leaver}`, old);
    this.w.people.set(leaver, { ...joiner, key: leaver });
    this.bump("joiners");
  }

  /** A mis-weighed ingredient is corrected on an in-progress batch: reverse the record, re-post the right lot. */
  async recordReversal(today: string, plant: Plant) {
    const b = plant.batchLog.filter((x) => x.day === today).at(0);
    if (!b) return;
    const detail = await this.w.call(this.p("prodMgr"), "GET", `/production/batches/${b.batchId}`);
    const rec = (detail.body?.records ?? []).find(
      (r: any) => r.kind === "consumption" && !r.reversesRecordId,
    );
    if (!rec) return;
    const batchStatus = detail.body.status;
    const r = await this.w.call(
      this.p("prodMgr"),
      "POST",
      `/production/batches/${b.batchId}/records/${rec.id}/reverse`,
      { reason: "Wrong scale reading" },
      [201, 409, 403],
    );
    if (r.status === 201) {
      this.bump("record_reversals");
      const item = rec.item?.id ?? rec.itemId;
      const qty = rec.quantity?.base ?? rec.amount?.base;
      if (item && qty) plant.model.set(item, (plant.model.get(item) ?? 0) + Math.abs(qty));
      // Then re-post the same quantity so stock returns to the true position.
      const again = await this.w.call(
        this.p("prodMgr"),
        "POST",
        `/production/batches/${b.batchId}/consumption`,
        {
          lines: [
            {
              lotId: rec.lotId,
              locationId: rec.locationId,
              quantity: Math.abs(qty),
              unit: (rec.item?.unit ?? "kg") === "kg" ? "g" : (rec.item?.unit ?? "each"),
            },
          ],
        },
        [201, 409],
      );
      if (again.status === 201 && item) plant.model.set(item, (plant.model.get(item) ?? 0) - Math.abs(qty));
      else {
        if (batchStatus === "completed") this.bump("reversal_on_completed_not_reposted");
        // The reversed record no longer counts as consumption: keep the trace expectation in step.
        const stillUsed = (detail.body?.records ?? []).some(
          (r: any) =>
            r.kind === "consumption" && r.id !== rec.id && r.lotId === rec.lotId && !r.reversesRecordId,
        );
        if (!stillUsed) b.consumedLotIds = b.consumedLotIds.filter((l) => l !== rec.lotId);
      }
    }
  }
}
