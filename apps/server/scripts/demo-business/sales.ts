import { randomUUID } from "node:crypto";
import type { Ctx } from "./api";
import { addDays } from "./api";
import { hash, prices } from "./commercial";

/** Sales orders (past, fulfilled by despatches; and open ones for the coming days), plus quotes. */
const dow = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();
import { pickRecord as pick } from "./api";

// customer → [weekdays, [item, qty][]]
const patterns: Record<string, [number[], [string, number][]]> = {
  "CUS-WESTCO": [
    [1, 3, 5],
    [
      ["FG-MILK-WH1", 600],
      ["FG-MILK-SS1", 500],
      ["FG-MILK-WH2", 120],
      ["FG-YOG-NAT500", 240],
      ["FG-YOG-STR150", 360],
      ["FG-BUTTER-S250", 150],
    ],
  ],
  "CUS-FARMFRESH": [
    [2, 4],
    [
      ["FG-MILK-WH1", 150],
      ["FG-YOG-NAT500", 60],
      ["FG-YOG-VAN150", 96],
      ["FG-CHEESE-S200", 60],
    ],
  ],
  "CUS-SCHOOLS": [
    [1, 2, 3, 4],
    [
      ["FG-MILK-SS1", 300],
      ["FG-YOG-STR150", 480],
      ["FG-YOG-RAS150", 480],
    ],
  ],
  "CUS-HOTEL": [
    [2, 5],
    [
      ["FG-CREAM-D300", 80],
      ["FG-BUTTER-S250", 60],
      ["FG-YOG-HG150", 48],
    ],
  ],
  "CUS-CAFES": [
    [1, 2, 3, 4, 5],
    [
      ["FG-MILK-WH1", 120],
      ["FG-MILK-SS1", 100],
      ["FG-CREAM-D300", 40],
    ],
  ],
  "CUS-DELI": [
    [3],
    [
      ["FG-CHEESE-S200", 36],
      ["FG-BUTTER-S250", 24],
      ["FG-YOG-HG150", 24],
    ],
  ],
  "CUS-HOSP": [
    [1, 4],
    [
      ["FG-YOG-NAT500", 100],
      ["FG-MILK-SS1", 150],
    ],
  ],
  "CUS-WHOLE": [
    [2, 5],
    [
      ["FG-YOG-NAT500", 48],
      ["FG-YOG-RAS150", 72],
      ["FG-BUTTER-S250", 36],
    ],
  ],
  "CUS-RESTAU": [
    [1, 3, 5],
    [
      ["FG-CREAM-D300", 48],
      ["FG-CHEESE-S200", 24],
    ],
  ],
  "CUS-FARMSHOP": [
    [2, 5],
    [
      ["FG-MILK-WH1", 60],
      ["FG-YOG-STR150", 48],
      ["FG-BUTTER-S250", 24],
    ],
  ],
};

export async function sales(ctx: Ctx) {
  const { api, today } = ctx;
  const itemId = ctx.ids.item!,
    cus = ctx.ids.customer!;
  const priceOf = (c: string, i: string) => prices.find((p) => p[0] === c && p[1] === i)?.[2];
  const existing = (await api.get("/sales/orders?limit=100")).orders as any[];
  const haveRef = new Set(existing.filter((o) => o.status !== "cancelled").map((o) => o.customerReference));
  const existingDespatch = (await api.get("/despatch?limit=200")).despatches as any[];
  const despRef = new Set(existingDespatch.map((d) => d.externalReference));

  const stock = async () => {
    const out = new Map<
      string,
      { lotId: string; locationId: string; qty: number; exp: string; made: string }[]
    >();
    for (let off = 0; ; off += 200) {
      const page = (await api.get(`/stock/lots?limit=200&offset=${off}`)).lots as any[];
      for (const l of page) {
        if (l.item.type !== "finished" || l.status !== "available") continue;
        for (const b of l.balances)
          if (b.amount.display > 0)
            out.set(l.item.code, [
              ...(out.get(l.item.code) ?? []),
              {
                lotId: l.id,
                locationId: b.locationId,
                qty: b.amount.display,
                exp: l.expiresOn ?? "9999",
                made: String(l.lotCode).slice(-6)
                  ? `20${String(l.lotCode).slice(-6).slice(0, 2)}-${String(l.lotCode).slice(-4, -2)}-${String(l.lotCode).slice(-2)}`
                  : "0000",
              },
            ]);
      }
      if (page.length < 200) break;
    }
    for (const v of out.values()) v.sort((a, b) => a.exp.localeCompare(b.exp));
    return out;
  };
  // Clean up anything a failed earlier run left half-done.
  for (const d of existingDespatch.filter((x) => x.status === "draft" && x.externalReference))
    await api.post(`/despatch/${d.id}/void`, {
      commandId: randomUUID(),
      reason: "Abandoned draft from a failed load.",
    });
  const confirmedRefs = new Set(
    existingDespatch.filter((x) => x.status === "confirmed").map((x) => x.externalReference),
  );
  for (const o of existing.filter(
    (x) =>
      x.status === "confirmed" &&
      /-PO-\d{8}$/.test(x.customerReference) &&
      !confirmedRefs.has(x.customerReference) &&
      x.customerReference.slice(-8) < today.replace(/-/g, ""),
  )) {
    await api.post(`/sales/orders/${o.id}/cancel`, {
      commandId: randomUUID(),
      expectedRevision: o.revision,
      reason: "Superseded; re-entered with delivery.",
    });
    haveRef.delete(o.customerReference);
  }
  let fg = await stock();
  let orders = 0,
    despatches = 0,
    open = 0,
    quotes = 0;

  const docFor = (cc: string, due: string, wanted: [string, number][], ref: string) => ({
    customerId: cus[cc],
    deliverySiteId: null,
    customerReference: ref,
    currency: "GBP",
    validUntil: null,
    terms: "Net 30 days from invoice.",
    notes: "",
    lines: wanted.map(([code, q]) => ({
      itemId: itemId[code],
      quantity: q,
      unit: "each",
      dueOn: due,
      unitPrice: priceOf(cc, code) ?? 1,
      note: "",
    })),
  });

  // History: last 3 weeks of weekday deliveries
  for (let d = -21; d <= -1; d++) {
    const day = addDays(today, d);
    for (const [cc, [days, want]] of Object.entries(patterns)) {
      if (!days.includes(dow(day))) continue;
      const ref = `${cc.slice(4, 8)}-PO-${day.replace(/-/g, "")}`;
      if (haveRef.has(ref)) continue;
      const variance = 0.85 + ((ref.length * 7 + day.charCodeAt(9) * 13 + day.charCodeAt(8)) % 30) / 100;
      const wanted = want.map(
        ([c, q]) => [c, Math.max(6, Math.round((q * variance) / 6) * 6)] as [string, number],
      );

      // Only sell from lots that existed on the day and are still in date today (the API checks expiry against today).
      const lines: any[] = [];
      const fulfilled: [string, number][] = [];
      for (const [code, q] of wanted) {
        let need = q;
        const picked: any[] = [];
        for (const lot of fg.get(code) ?? []) {
          if (need <= 0) break;
          if (lot.made > day || lot.exp < today) continue;
          const take = Math.min(need, lot.qty);
          if (take <= 0) continue;
          picked.push({ lot, take });
          need -= take;
        }
        if (need > 0) continue; // can't fill the whole line: leave it off the order
        for (const { lot, take } of picked) {
          lot.qty -= take;
          lines.push({ lotId: lot.lotId, locationId: lot.locationId, quantity: take, unit: "each" });
        }
        fulfilled.push([code, q]);
      }
      if (!lines.length) continue;

      let o = pick(
        await api.post("/sales/orders", {
          commandId: randomUUID(),
          kind: "order",
          document: docFor(cc, day, fulfilled, ref),
        }),
        "order",
      );
      o = pick(
        await api.post(`/sales/orders/${o.id}/confirm`, {
          commandId: randomUUID(),
          expectedRevision: o.revision,
          reason: "Customer confirmed by email.",
        }),
        "order",
      );
      orders++;
      const merged = Object.values(
        Object.fromEntries(lines.map((l) => [`${l.lotId}:${l.locationId}`, l])),
      ) as any[];
      let dsp = pick(
        await api.post("/despatch", {
          customerId: cus[cc],
          despatchedOn: day,
          externalReference: ref,
          notes: "Delivered by own van.",
          lines: merged,
        }),
        "despatch",
      );
      const step = async (path: string, body: any) => {
        dsp = pick(
          await api.post(`/despatch/${dsp.id}/${path}`, {
            commandId: randomUUID(),
            expectedUpdatedAt: dsp.updatedAt,
            ...body,
          }),
          "despatch",
        );
      };
      await step("allocate", { note: "Allocated first-expired-first-out." });
      await step("pack", {
        note: "Packed onto one roll cage.",
        packages: [
          {
            reference: `ROLL-${ref}`.slice(0, 40),
            contents: dsp.lines.map((l: any) => ({
              lineId: l.id,
              quantity: l.quantity?.display ?? l.quantity,
              unit: l.unit ?? "each",
            })),
          },
        ],
      });
      await step("load-check", {
        vehicle: "KN24 MLK",
        carrier: "Knotmilk own fleet",
        clean: "pass",
        secure: "pass",
        segregation: "pass",
        temperatureMode: "controlled",
        temperatureC: 2.6 + (hash(ref) % 20) / 10,
        minC: 0,
        maxC: 5,
        temperatureBasis: "Reefer display at loading",
        note: "Vehicle clean, load secured, chilled segregated from ambient.",
      });
      await step("confirm", {});
      despatches++;
      await api.post(`/despatch/${dsp.id}/proof`, {
        commandId: randomUUID(),
        deliveredAt: `${day}T0${6 + (hash(ref) % 3)}:${10 + (hash(ref) % 45)}:00.000Z`,
        receivedBy: ["Goods-in team", "Store manager", "Head chef", "Kitchen porter"][hash(ref) % 4],
        evidenceReference: `POD-${ref}`,
        note: "Signed on delivery, no issues reported.",
        lines: dsp.lines.map((l: any) => ({
          lineId: l.id,
          deliveredQuantity: l.quantity?.display ?? l.quantity,
          refusedQuantity: 0,
          unit: l.unit ?? "each",
        })),
      });
    }
  }

  // Open orders for the coming week
  for (let d = 0; d <= 6; d++) {
    const day = addDays(today, d);
    for (const [cc, [days, want]] of Object.entries(patterns)) {
      if (!days.includes(dow(day))) continue;
      const ref = `${cc.slice(4, 8)}-PO-${day.replace(/-/g, "")}`;
      if (haveRef.has(ref)) continue;
      let o = pick(
        await api.post("/sales/orders", {
          commandId: randomUUID(),
          kind: "order",
          document: docFor(cc, day, want, ref),
        }),
        "order",
      );
      if (d <= 3)
        await api.post(`/sales/orders/${o.id}/confirm`, {
          commandId: randomUUID(),
          expectedRevision: o.revision,
          reason: "Customer confirmed.",
        });
      open++;
    }
  }

  // Quotes
  const quoteFor: [string, string, [string, number][]][] = [
    [
      "CUS-HOTEL",
      "Spring menu cream and butter",
      [
        ["FG-CREAM-D300", 120],
        ["FG-BUTTER-S250", 80],
      ],
    ],
    [
      "CUS-HOSP",
      "Ward breakfast yogurt trial",
      [
        ["FG-YOG-NAT500", 150],
        ["FG-YOG-VAN150", 400],
      ],
    ],
    ["CUS-WHOLE", "Christmas range: honey & granola", [["FG-YOG-HG150", 300]]],
  ];
  for (const [cc, title, want] of quoteFor) {
    const ref = `QUOTE-${title.slice(0, 10)}`.trim();
    if (haveRef.has(ref)) continue;
    const q = pick(
      await api.post("/sales/orders", {
        commandId: randomUUID(),
        kind: "quote",
        document: {
          ...docFor(cc, addDays(today, 14), want, ref),
          validUntil: addDays(today, 30),
          notes: title,
        },
      }),
      "order",
    );
    if (quotes++ === 0)
      await api.post(`/sales/orders/${q.id}/issue`, {
        commandId: randomUUID(),
        expectedRevision: q.revision,
        reason: "Sent to customer.",
      });
  }
  return `${orders} past orders, ${despatches} despatches, ${open} open orders, ${quotes} quotes`;
}
