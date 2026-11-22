import {
  classifyExpiry,
  newId,
  pickFefo,
  stockAmount,
  stockAdjustmentSchema,
  stocktakeSchema,
  stockWasteSchema,
  toBaseQuantity,
  type UnitCode,
} from "@knotworking/core";
import type { Hono } from "hono";

/**
 * In-memory stand-in for the Stock module's routes (apps/server/src/routes/stock.ts), over the
 * fake items. Balances are derived from the movements, as in the API.
 */
export function mountFakeStock(
  app: Hono,
  ws: string,
  catalogue: { items: Record<string, any>[]; suppliers: Record<string, any>[] },
) {
  const err = (code: string, message: string, details?: unknown) => ({ error: { code, message, details } });
  const today = "2026-11-11";
  const now = "2026-11-11T09:00:00.000Z";
  const location = (name: string, code: string | null, storage = "ambient") => ({
    id: newId(),
    name,
    code,
    storage,
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  const locations: Record<string, any>[] = [
    location("Dry store", "DS"),
    location("Chiller 1", "CH1", "chilled"),
  ];
  const lots: Record<string, any>[] = [];
  const movements: Record<string, any>[] = [];
  const itemOf = (id: string): any => catalogue.items.find((i) => i.id === id);
  const summary = (i: Record<string, any>) => ({
    id: i.id,
    code: i.code,
    name: i.name,
    type: i.type,
    unit: i.unit,
    status: i.status,
  });
  const balances = (lotId: string) => {
    const byLocation = new Map<string, number>();
    for (const m of movements.filter((x) => x.lotId === lotId)) {
      byLocation.set(m.locationId, (byLocation.get(m.locationId) ?? 0) + m.quantity);
    }
    return [...byLocation]
      .filter(([, q]) => q !== 0)
      .map(([locationId, quantity]) => ({ locationId, quantity }));
  };
  const lotView = (lot: Record<string, any>) => {
    const item = itemOf(lot.itemId)!;
    const list = balances(lot.id);
    return {
      ...lot,
      item: summary(item),
      supplierName: catalogue.suppliers.find((s) => s.id === lot.supplierId)?.name ?? null,
      expiryState: classifyExpiry(lot.expiresOn, today),
      onHand: stockAmount(
        list.reduce((s, b) => s + b.quantity, 0),
        item,
      ),
      balances: list.map((b) => ({
        locationId: b.locationId,
        locationName: locations.find((l) => l.id === b.locationId)!.name,
        locationCode: locations.find((l) => l.id === b.locationId)!.code,
        amount: stockAmount(b.quantity, item),
      })),
    };
  };
  const lotDetail = (lot: Record<string, any>) => {
    const item = itemOf(lot.itemId)!;
    const supplier = catalogue.suppliers.find((s) => s.id === lot.supplierId);
    return {
      ...lotView(lot),
      statusChangedByName: null,
      supplier: supplier
        ? {
            id: supplier.id,
            name: supplier.name,
            code: supplier.code,
            approvalStatus: supplier.approvalStatus,
          }
        : null,
      movements: movements
        .filter((m) => m.lotId === lot.id)
        .map((m) => ({
          ...m,
          amount: stockAmount(m.quantity, item),
          lotCode: lot.lotCode,
          locationName: locations.find((l) => l.id === m.locationId)!.name,
          actorName: "Ada Lovelace",
          item: summary(item),
          reversed: false,
        })),
    };
  };
  const movement = (fields: Record<string, unknown>): Record<string, any> => {
    const row = {
      id: newId(),
      transferId: null,
      reversesMovementId: null,
      reason: null,
      reference: null,
      actorId: null,
      occurredAt: now,
      createdAt: now,
      ...fields,
    };
    movements.push(row);
    return row;
  };
  const toBase = (quantity: number, unit: UnitCode, item: any) => toBaseQuantity(quantity, unit, item);

  app.get(`${ws}/stock/locations`, (c) => {
    const status = c.req.query("status") ?? "active";
    return c.json({
      locations: locations
        .filter((l) => status === "all" || l.status === status)
        .map((l) => ({
          ...l,
          lotCount: lots.filter((lot) => balances(lot.id).some((b) => b.locationId === l.id)).length,
        })),
    });
  });

  app.get(`${ws}/stock/levels`, (c) => {
    const q = c.req.query();
    const rows = catalogue.items
      .filter(
        (i) =>
          (!q.itemType || i.type === q.itemType) &&
          (!q.q || i.name.toLowerCase().includes(q.q.toLowerCase())),
      )
      .map((item: any) => {
        const held = lots
          .filter((l) => l.itemId === item.id)
          .map((l) => ({
            lot: l,
            qty: balances(l.id)
              .filter((b) => !q.locationId || b.locationId === q.locationId)
              .reduce((s, b) => s + b.quantity, 0),
          }))
          .filter((x) => x.qty !== 0);
        const sum = (status?: string) =>
          held.filter((x) => !status || x.lot.status === status).reduce((s, x) => s + x.qty, 0);
        const earliest =
          held
            .map((x) => x.lot.expiresOn)
            .filter(Boolean)
            .sort()[0] ?? null;
        return {
          item: summary(item),
          onHand: stockAmount(sum(), item),
          available: stockAmount(sum("available"), item),
          quarantine: stockAmount(sum("quarantine"), item),
          rejected: stockAmount(sum("rejected"), item),
          lotCount: held.length,
          earliestExpiry: earliest,
          expiryState: earliest ? classifyExpiry(earliest, today) : null,
        };
      })
      .filter((r) => r.lotCount > 0 || q.includeZero === "true");
    const limit = Number(q.limit ?? 50);
    const offset = Number(q.offset ?? 0);
    return c.json({ levels: rows.slice(offset, offset + limit), total: rows.length, limit, offset });
  });

  app.get(`${ws}/stock/lots`, (c) => {
    const q = c.req.query();
    const text = q.q?.toLowerCase();
    const found = lots
      .filter(
        (l) =>
          (!q.itemId || l.itemId === q.itemId) &&
          (!q.status || l.status === q.status) &&
          (!text ||
            l.lotCode.toLowerCase().includes(text) ||
            l.supplierLotCode?.toLowerCase().includes(text)) &&
          (q.includeEmpty === "true" || balances(l.id).length > 0) &&
          (!q.expiringWithinDays ||
            (l.expiresOn && classifyExpiry(l.expiresOn, today, Number(q.expiringWithinDays)) !== "ok")),
      )
      .sort((a, b) => (a.expiresOn ?? "9999").localeCompare(b.expiresOn ?? "9999"));
    const limit = Number(q.limit ?? 50);
    const offset = Number(q.offset ?? 0);
    return c.json({
      lots: found.slice(offset, offset + limit).map(lotView),
      total: found.length,
      limit,
      offset,
    });
  });

  app.get(`${ws}/stock/lots/:id`, (c) => {
    const lot = lots.find((l) => l.id === c.req.param("id"));
    return lot ? c.json(lotDetail(lot)) : c.json(err("not_found", "Lot not found"), 404);
  });

  app.get(`${ws}/stock/items/:itemId/pick`, (c) => {
    const item = itemOf(c.req.param("itemId"));
    if (!item) return c.json(err("not_found", "Item not found"), 404);
    const required = toBase(Number(c.req.query("quantity")), c.req.query("unit") as UnitCode, item);
    if (required === null) return c.json(err("unit_not_convertible", "Can't convert that unit"), 400);
    const candidates = lots
      .filter((l) => l.itemId === item.id)
      .flatMap((l) =>
        balances(l.id).map((b) => ({
          ...b,
          lotId: l.id,
          lotCode: l.lotCode,
          status: l.status,
          expiresOn: l.expiresOn,
          expiryType: l.expiryType,
          receivedOn: l.receivedOn,
        })),
      );
    const result = pickFefo(candidates, required, today);
    return c.json({
      item: summary(item),
      required: stockAmount(required, item),
      allocated: stockAmount(result.allocated, item),
      shortfall: stockAmount(result.shortfall, item),
      allocations: result.allocations.map((a) => ({
        lotId: a.candidate.lotId,
        lotCode: a.candidate.lotCode,
        locationId: a.candidate.locationId,
        locationName: locations.find((l) => l.id === a.candidate.locationId)!.name,
        expiresOn: a.candidate.expiresOn,
        expiryType: a.candidate.expiryType,
        receivedOn: a.candidate.receivedOn,
        pastBestBefore: a.pastBestBefore,
        amount: stockAmount(a.quantity, item),
      })),
    });
  });

  app.post(`${ws}/stock/receipts`, async (c) => {
    const body = await c.req.json();
    const item = itemOf(body.itemId);
    if (!item) return c.json(err("not_found", "Item not found"), 404);
    if (!locations.some((l) => l.id === body.locationId))
      return c.json(err("not_found", "Location not found"), 404);
    const supplier = catalogue.suppliers.find((s) => s.id === body.supplierId);
    if (supplier && supplier.approvalStatus === "pending" && body.status !== "quarantine")
      return c.json(
        err("supplier_not_approved", `${supplier.name} is not approved yet; receive into quarantine`),
        409,
      );
    const quantity = toBase(body.quantity, body.unit, item);
    if (quantity === null) return c.json(err("unit_not_convertible", "Can't convert that unit"), 400);
    const lot = {
      id: newId(),
      itemId: item.id,
      lotCode: body.lotCode ?? `L261111-${String(lots.length + 1).padStart(3, "0")}`,
      supplierId: body.supplierId ?? null,
      supplierLotCode: body.supplierLotCode ?? null,
      receivedOn: body.receivedOn,
      expiresOn: body.expiresOn ?? null,
      expiryType: body.expiryType ?? null,
      status: body.status ?? "available",
      statusChangedAt: null,
      statusChangedBy: null,
      statusNote: null,
      notes: body.notes ?? null,
      createdAt: now,
      updatedAt: now,
    };
    lots.push(lot);
    movement({
      lotId: lot.id,
      itemId: item.id,
      locationId: body.locationId,
      quantity,
      type: "receipt",
      reference: body.reference ?? null,
    });
    return c.json(lotDetail(lot), 201);
  });

  app.post(`${ws}/stock/transfers`, async (c) => {
    const body = await c.req.json();
    const lot = lots.find((l) => l.id === body.lotId);
    if (!lot) return c.json(err("not_found", "Lot not found"), 404);
    const item = itemOf(lot.itemId)!;
    const quantity = toBase(body.quantity, body.unit, item)!;
    const available = balances(lot.id).find((b) => b.locationId === body.fromLocationId)?.quantity ?? 0;
    if (available < quantity)
      return c.json(
        err("insufficient_stock", "Not enough stock", { available: stockAmount(available, item) }),
        409,
      );
    const transferId = newId();
    const common = {
      lotId: lot.id,
      itemId: item.id,
      transferId,
      reason: body.reason ?? null,
      reference: body.reference ?? null,
    };
    const rows = [
      movement({ ...common, locationId: body.fromLocationId, quantity: -quantity, type: "transfer_out" }),
      movement({ ...common, locationId: body.toLocationId, quantity, type: "transfer_in" }),
    ];
    return c.json(
      { transferId, movements: rows.map((m) => ({ ...m, amount: stockAmount(m.quantity as number, item) })) },
      201,
    );
  });

  const found = (lotId: string, locationId: string) => {
    const lot = lots.find((l) => l.id === lotId);
    if (!lot) return { error: ["not_found", "Lot not found", 404] as const, lot: null, item: null };
    if (!locations.some((l) => l.id === locationId))
      return { error: ["not_found", "Location not found", 404] as const, lot: null, item: null };
    return { error: null, lot, item: itemOf(lot.itemId)! };
  };
  const balanceAt = (lotId: string, locationId: string) =>
    balances(lotId).find((b) => b.locationId === locationId)?.quantity ?? 0;
  const view = (m: Record<string, any>, item: any) => ({ ...m, amount: stockAmount(m.quantity, item) });

  app.post(`${ws}/stock/waste`, async (c) => {
    const parsed = stockWasteSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json(err("invalid_input", parsed.error.message), 400);
    const body = parsed.data;
    const hit = found(body.lotId, body.locationId);
    if (hit.error) return c.json(err(hit.error[0], hit.error[1]), hit.error[2]);
    const quantity = toBase(body.quantity, body.unit, hit.item)!;
    const available = balanceAt(body.lotId, body.locationId);
    if (available < quantity)
      return c.json(
        err("insufficient_stock", "Not enough stock", { available: stockAmount(available, hit.item) }),
        409,
      );
    const row = movement({
      lotId: body.lotId,
      itemId: hit.item.id,
      locationId: body.locationId,
      quantity: -quantity,
      type: "waste",
      reason: body.reason,
      reference: body.reference ?? null,
    });
    return c.json(view(row, hit.item), 201);
  });

  app.post(`${ws}/stock/adjustments`, async (c) => {
    const parsed = stockAdjustmentSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json(err("invalid_input", parsed.error.message), 400);
    const body = parsed.data;
    const hit = found(body.lotId, body.locationId);
    if (hit.error) return c.json(err(hit.error[0], hit.error[1]), hit.error[2]);
    const magnitude = toBase(Math.abs(body.quantity), body.unit, hit.item)!;
    const quantity = body.quantity < 0 ? -magnitude : magnitude;
    const available = balanceAt(body.lotId, body.locationId);
    if (quantity < 0 && available < magnitude)
      return c.json(
        err("insufficient_stock", "Not enough stock", { available: stockAmount(available, hit.item) }),
        409,
      );
    const row = movement({
      lotId: body.lotId,
      itemId: hit.item.id,
      locationId: body.locationId,
      quantity,
      type: "adjustment",
      reason: body.reason,
      reference: body.reference ?? null,
    });
    return c.json(view(row, hit.item), 201);
  });

  app.post(`${ws}/stock/stocktakes`, async (c) => {
    const parsed = stocktakeSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json(err("invalid_input", parsed.error.message), 400);
    const body = parsed.data;
    const reference = body.reference ?? "ST-20261111-0900";
    const variances: Record<string, unknown>[] = [];
    const pending: Record<string, any>[] = [];
    for (const count of body.counts) {
      const hit = found(count.lotId, count.locationId);
      if (hit.error) return c.json(err(hit.error[0], hit.error[1]), hit.error[2]);
      const counted = toBase(count.countedQuantity, count.unit, hit.item)!;
      const expected = balanceAt(count.lotId, count.locationId);
      const variance = counted - expected;
      variances.push({
        lotId: hit.lot.id,
        lotCode: hit.lot.lotCode,
        item: summary(hit.item),
        locationId: count.locationId,
        locationName: locations.find((l) => l.id === count.locationId)!.name,
        expected: stockAmount(expected, hit.item),
        counted: stockAmount(counted, hit.item),
        variance: stockAmount(variance, hit.item),
      });
      if (variance !== 0)
        pending.push({
          lotId: hit.lot.id,
          itemId: hit.item.id,
          locationId: count.locationId,
          quantity: variance,
          type: "stocktake",
          reason: body.reason ?? null,
          reference,
        });
    }
    for (const m of pending) movement(m);
    return c.json({ reference, posted: pending.length, variances }, 201);
  });

  app.get(`${ws}/stock/lots/:id/release-check`, (c) => {
    const lot = lots.find((l) => l.id === c.req.param("id"));
    if (!lot) return c.json({ error: { code: "not_found", message: "Lot not found" } }, 404);
    const pending = {
      kind: "tests_pending",
      status: "block",
      module: "testing",
      label: "No test results outstanding",
      detail: "1 sample is awaiting results",
      refs: [{ id: "s1", label: "S-2026-0001" }],
      fromRule: false,
      hidden: false,
    };
    return c.json({
      lotId: lot.id,
      status: lot.status,
      blocked: true,
      ruleVersion: null,
      rule: null,
      checks: [pending],
    });
  });
  return { locations, lots, movements };
}
