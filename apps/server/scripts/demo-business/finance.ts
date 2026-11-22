import { randomUUID } from "node:crypto";
import type { Ctx } from "./api";
import { addDays, pickRecord as pick } from "./api";
import { hash } from "./commercial";
import { items } from "./foundation";
import { loginAs } from "./team";

const isoWeek = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const week1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const w =
    1 + Math.round(((d.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(w).padStart(2, "0")}`;
};

export async function finance(ctx: Ctx) {
  const { api, today } = ctx;
  const itemId = ctx.ids.item!,
    sup = ctx.ids.supplier!;
  const approver = await loginAs(ctx, "priya.d@knotmilk.example");
  let made = 0;

  // ── Purchase invoices matched to received orders, approved by Finance ──
  const orders = ((await api.get("/purchasing/orders?status=all&limit=200")).orders as any[]).filter(
    (o) => o.notes?.startsWith("Weekly replenishment") && o.status !== "cancelled",
  );
  const have = new Set(
    ((await api.get("/purchasing/invoices?status=all&limit=500")).invoices as any[]).map(
      (i) => i.invoiceNumber,
    ),
  );
  const supName = Object.fromEntries(Object.entries(sup).map(([k, v]) => [v, k.replace("SUP-", "")]));
  let n = 0;
  for (const o of orders) {
    const number = `${supName[o.supplierId] ?? "SUP"}-INV-${String((hash(o.id) % 90000) + 10000)}`;
    if (have.has(number) || [...have].some((h) => h.endsWith(String((hash(o.id) % 90000) + 10000)))) continue;
    const full = await api.get(`/purchasing/orders/${o.id}`);
    const order = full.order ?? full;
    const received = (order.lines as any[]).filter((l) => l.received.inLineUnit > 0);
    if (!received.length) continue;
    const invoiceDate = addDays(order.sentAt?.slice(0, 10) ?? today, 3);
    const net = received.reduce((t, l) => t + l.received.inLineUnit * (l.unitPrice ?? 0), 0);
    const inv = pick(
      await api.post("/purchasing/invoices", {
        supplierId: o.supplierId,
        invoiceNumber: number,
        invoiceDate,
        dueDate: addDays(invoiceDate, 30),
        vat: 0,
        notes: `Matched to ${o.reference}.`,
        lines: received.map((l) => ({
          kind: "order",
          orderLineId: l.id,
          quantity: l.received.inLineUnit,
          unitPrice: l.unitPrice ?? 0,
          description: null,
        })),
      }),
      "invoice",
    );
    // ~15% are left as drafts (awaiting approval); the rest approved by Finance
    if (hash(o.id) % 7 !== 0)
      await approver
        .post(`/purchasing/invoices/${inv.id}/approve`, { reason: "Matched to goods received." })
        .catch((e) => console.warn("invoice approve:", String(e.message).slice(0, 200)));
    n++;
  }
  made += n;

  // A supplier credit note for a price reduction
  const credits = (await api.get("/purchasing/credit-notes?status=all")).creditNotes as any[];
  if (!credits.length) {
    const invs = ((await api.get("/purchasing/invoices?status=current&limit=100")).invoices as any[]).filter(
      (i) => i.status === "approved",
    );
    const target = invs[0];
    if (target) {
      const full = pick(await api.get(`/purchasing/invoices/${target.id}`), "invoice");
      const line = full.lines?.[0];
      if (line) {
        const cn = pick(
          await api.post("/purchasing/credit-notes", {
            invoiceId: target.id,
            creditNoteNumber: `CN-${target.invoiceNumber.slice(-5)}`,
            creditDate: addDays(today, -6),
            vat: 0,
            notes: "Price reduction agreed after a contract review.",
            lines: [
              {
                kind: "invoice_line",
                invoiceLineId: line.id,
                reason: "price",
                quantity: 1,
                unitPrice: 25,
                description: "Agreed price reduction",
              },
            ],
          }),
          "creditNote",
        );
        await approver
          .post(`/purchasing/credit-notes/${cn.id}/approve`, { reason: "Agreed with the supplier." })
          .catch((e) => console.warn("credit approve:", String(e.message).slice(0, 160)));
        made++;
      }
    }
  }

  // ── Costing: absorption rates and standard costs ──
  const rates = (await api.get("/costing/rates")).rates as any[];
  if (!rates.length) {
    await api.put("/costing/rates", {
      lineId: null,
      effectiveFrom: addDays(today, -200),
      labourPerHour: 17.5,
      labourPerKg: 0,
      overheadPerHour: 38,
      overheadPerKg: 0.015,
      note: "Workspace default for 2026.",
    });
    for (const [name, lab, ovh] of [
      ["Milk pasteurising & bottling line", 118, 64],
      ["Yogurt incubation & filling line", 96, 58],
      ["Butter, cream & cheese room", 72, 41],
    ] as [string, number, number][]) {
      const line = ((await api.get("/production/lines")).lines as any[]).find((l) => l.name === name);
      if (line)
        await api.put("/costing/rates", {
          lineId: line.id,
          effectiveFrom: addDays(today, -200),
          labourPerHour: lab / 5.5,
          labourPerKg: 0,
          overheadPerHour: ovh,
          overheadPerKg: 0,
          note: `${name}: crew and plant overhead.`,
        });
    }
    made++;
  }
  for (const it of items.filter((i) => i.type === "finished" || i.type === "wip")) {
    await api
      .put("/costing/standard-costs", {
        itemId: itemId[it.code],
        effectiveFrom: addDays(today, -200),
        cost: it.standardCost,
        note: "Standard cost from the 2026 budget.",
      })
      .catch(() => {});
  }
  const closes = (await api.get("/costing/closes")).closes as any[];
  if (!closes.length) {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - 1);
    const prev = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    await api
      .post("/costing/closes", { period: "month", of: prev, note: "Month-end close.", acknowledgeGaps: true })
      .catch((e) => console.warn("costing close:", String(e.message).slice(0, 200)));
  }

  // ── Demand: pack units and weekly forecast ──
  const packs = (await api.get("/demand/pack-units")).packUnits as any[];
  if (!packs.length) {
    const defs: [string, string, number][] = [
      ["FG-MILK-WH1", "case", 12],
      ["FG-MILK-SS1", "case", 12],
      ["FG-MILK-WH2", "case", 6],
      ["FG-YOG-NAT500", "case", 6],
      ["FG-YOG-STR150", "case", 12],
      ["FG-YOG-RAS150", "case", 12],
      ["FG-YOG-VAN150", "case", 12],
      ["FG-YOG-HG150", "case", 12],
      ["FG-BUTTER-S250", "case", 12],
      ["FG-CREAM-D300", "case", 12],
      ["FG-CHEESE-S200", "case", 12],
    ];
    await api.put("/demand/pack-units", {
      packUnits: defs.map(([itemCode, name, size]) => ({ itemCode, name, size, unit: "each" })),
    });
    made++;
  }
  const lines = (await api.get("/demand/lines?limit=200")).lines as any[];
  if (lines.length < 20) {
    const weekly: Record<string, [string, number][]> = {
      "Westcountry Co-operative Stores": [
        ["FG-MILK-WH1", 1800],
        ["FG-MILK-SS1", 1500],
        ["FG-YOG-NAT500", 720],
        ["FG-YOG-STR150", 1080],
        ["FG-BUTTER-S250", 450],
      ],
      "Mendip Schools Catering Service": [
        ["FG-MILK-SS1", 1200],
        ["FG-YOG-STR150", 1920],
        ["FG-YOG-RAS150", 1920],
      ],
      "Bean & Leaf Café Group": [
        ["FG-MILK-WH1", 600],
        ["FG-MILK-SS1", 500],
        ["FG-CREAM-D300", 200],
      ],
      "FarmFresh Local Grocers": [
        ["FG-MILK-WH1", 300],
        ["FG-YOG-VAN150", 192],
        ["FG-CHEESE-S200", 120],
      ],
    };
    const out: any[] = [];
    for (let w = 0; w < 8; w++) {
      const monday = new Date(`${today}T00:00:00Z`);
      monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7) + w * 7);
      const period = isoWeek(monday.toISOString().slice(0, 10));
      for (const [customer, list] of Object.entries(weekly))
        for (const [itemCode, q] of list) {
          const seasonal = 1 + Math.sin((w + 1) / 2) * 0.08 + (hash(customer + itemCode + w) % 9) / 100;
          out.push({
            itemCode,
            period,
            quantity: Math.round((q * seasonal) / 12) * 12,
            unit: "each",
            customer,
            note: "Customer forecast",
            externalRef: `FC-${period}-${(hash(customer + itemCode) % 900) + 100}`,
          });
        }
    }
    for (let i = 0; i < out.length; i += 50) await api.put("/demand/lines", { lines: out.slice(i, i + 50) });
    made += out.length;
  }
  return `${made} finance records`;
}
