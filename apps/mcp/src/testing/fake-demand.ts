import {
  buildDemandSummary,
  customerKey,
  demandAction,
  demandEntriesFromInput,
  demandImportSchema,
  demandKey,
  demandLinesSetSchema,
  demandRange,
  formatWeek,
  newId,
  packUnitsSetSchema,
  parseDemandCsv,
  parsePeriod,
  resolveDemandEntries,
  stockAmount,
  type DemandEntry,
  type DemandItem,
  type DemandRowError,
} from "@knotworking/core";
import type { Hono } from "hono";

/**
 * In-memory stand-in for the Demand module's routes (apps/server/src/routes/demand.ts). It has
 * its own finished goods (the fake items are ingredients and packaging) and also sees the fake
 * items, so "not a product" errors can be exercised.
 */
export function mountFakeDemand(app: Hono, ws: string, catalogue: { items: Record<string, any>[] }) {
  const err = (code: string, message: string, details?: unknown) => ({ error: { code, message, details } });
  const today = "2026-11-11";
  const now = "2026-11-11T09:00:00.000Z";
  const product = (code: string, name: string, unit: string, extra: object = {}) => ({
    id: newId(),
    code,
    name,
    type: "finished",
    unit,
    status: "active",
    densityGPerMl: null,
    unitWeightG: null,
    ...extra,
  });
  const products: Record<string, any>[] = [
    product("CAKE-1", "Lemon cake", "each", { unitWeightG: 450 }),
    product("SOUP-1", "Tomato soup", "l"),
  ];
  const lines: Record<string, any>[] = [];
  const imports: Record<string, any>[] = [];
  const allItems = () => [...products, ...catalogue.items];
  const itemOf = (id: string): any => allItems().find((i) => i.id === id);
  const find = ({ itemId, itemCode }: { itemId?: string | undefined; itemCode?: string | undefined }) =>
    allItems().find(
      (i) => i.id === itemId || (itemCode && i.code.toLowerCase() === itemCode.toLowerCase()),
    ) as DemandItem | undefined;
  const summary = (i: Record<string, any>) => ({
    id: i.id,
    code: i.code,
    name: i.name,
    type: i.type,
    unit: i.unit,
    status: i.status,
  });
  const view = (line: Record<string, any>) => {
    const item = itemOf(line.itemId);
    return {
      ...line,
      week: formatWeek(line.periodStart),
      amount: stockAmount(line.quantity, item),
      item: summary(item),
      createdByName: "Ada Lovelace",
      updatedByName: "Ada Lovelace",
    };
  };
  const invalid = (errors: DemandRowError[]) =>
    err(
      "invalid_rows",
      `${new Set(errors.map((e) => e.row)).size} rows have problems; nothing was saved. ${errors
        .map((e) => `Row ${e.row}${e.column ? ` (${e.column})` : ""}: ${e.message}`)
        .join("; ")}`,
      { errors },
    );

  /** Plans and (unless `dryRun`) applies entries, like the service. */
  function apply(
    entries: DemandEntry[],
    source: string,
    importId: string | null,
    dryRun: boolean,
    replaceHorizon = false,
  ) {
    const { resolved, errors } = resolveDemandEntries(entries, find);
    if (errors.length) return { errors, plan: [], horizon: null };
    const live = (key: string): any =>
      lines.find((l) => !l.deletedAt && demandKey(l.itemId, l.periodStart, l.customer) === key);
    const plan = resolved.map((entry) => {
      const current = live(demandKey(entry.item.id, entry.periodStart, entry.customer));
      return { entry, current, action: demandAction(entry, current) };
    });
    let horizon: { from: string; to: string } | null = null;
    if (replaceHorizon && plan.length) {
      const weeks = plan.map((p) => p.entry.periodStart).sort();
      horizon = { from: weeks[0]!, to: weeks[weeks.length - 1]! };
      const inFile = new Set(
        plan.map((p) => demandKey(p.entry.item.id, p.entry.periodStart, p.entry.customer)),
      );
      for (const line of lines) {
        if (line.deletedAt || line.periodStart < horizon.from || line.periodStart > horizon.to) continue;
        if (inFile.has(demandKey(line.itemId, line.periodStart, line.customer))) continue;
        plan.push({
          entry: {
            row: 0,
            item: itemOf(line.itemId),
            periodStart: line.periodStart,
            customer: line.customer,
            quantity: null,
          } as any,
          current: line,
          action: "remove",
        });
      }
    }
    if (!dryRun) {
      for (const { entry, current, action } of plan) {
        if (action === "create") {
          lines.push({
            id: newId(),
            itemId: entry.item.id,
            periodStart: entry.periodStart,
            customer: entry.customer,
            quantity: entry.quantity,
            enteredQuantity: entry.entered?.quantity ?? null,
            enteredUnit: entry.entered?.unit ?? null,
            note: entry.note ?? null,
            externalRef: entry.externalRef ?? null,
            source,
            importId,
            createdBy: null,
            updatedBy: null,
            createdAt: now,
            updatedAt: now,
          });
        } else if (action === "update") {
          Object.assign(current!, {
            quantity: entry.quantity,
            enteredQuantity: entry.entered?.quantity ?? null,
            enteredUnit: entry.entered?.unit ?? null,
            ...(entry.note !== undefined ? { note: entry.note } : {}),
            ...(entry.externalRef !== undefined ? { externalRef: entry.externalRef } : {}),
            source,
            importId,
          });
        } else if (action === "remove") current!.deletedAt = now;
      }
    }
    return { errors: [], plan, horizon };
  }
  const counts = (plan: { action: string }[]) => ({
    created: plan.filter((p) => p.action === "create").length,
    updated: plan.filter((p) => p.action === "update").length,
    removed: plan.filter((p) => p.action === "remove").length,
    unchanged: plan.filter((p) => p.action === "unchanged").length,
  });

  const packUnitView = (item: Record<string, any>, p: { name: string; size: number }) => ({
    id: `pack-${item.code}-${p.name}`,
    itemId: item.id,
    name: p.name,
    size: p.size,
    item: summary(item),
    amount: stockAmount(p.size, item as { unit: any }),
  });
  app.get(`${ws}/demand/pack-units`, (c) => {
    const code = c.req.query("itemCode")?.toLowerCase();
    return c.json({
      packUnits: products
        .filter((i) => !code || i.code.toLowerCase() === code)
        .flatMap((i) =>
          ((i.packUnits ?? []) as { name: string; size: number }[]).map((p) => packUnitView(i, p)),
        ),
    });
  });
  app.put(`${ws}/demand/pack-units`, async (c) => {
    const parsed = packUnitsSetSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json(err("invalid_input", "Invalid input", parsed.error.issues), 400);
    const results = parsed.data.packUnits.map((p) => {
      const item = find({ itemId: p.itemId, itemCode: p.itemCode }) as Record<string, any> | undefined;
      const target = products.find((i) => i.id === item?.id);
      if (!target) return { row: 0, action: "unchanged", packUnit: null };
      const packs = ((target.packUnits ??= []) as { name: string; size: number }[]).filter(
        (x) => x.name.toLowerCase() !== p.name.toLowerCase(),
      );
      target.packUnits = p.size === null ? packs : [...packs, { name: p.name, size: p.size }];
      return {
        row: 0,
        action: p.size === null ? "remove" : "create",
        packUnit: p.size === null ? null : packUnitView(target, { name: p.name, size: p.size }),
      };
    });
    return c.json({ results });
  });
  app.get(`${ws}/demand/forecast`, (c) =>
    c.json({
      from: "2026-11-09",
      to: "2026-11-16",
      weeks: [],
      byCustomer: false,
      window: 8,
      seasonal: true,
      historyUntil: "2026-11-09",
      method: "Average weekly demand over the last 8 weeks.",
      rows: [],
    }),
  );
  app.post(`${ws}/demand/forecast/apply`, (c) =>
    c.json({ created: 0, updated: 0, removed: 0, unchanged: 0, lines: [], skipped: [] }),
  );
  app.get(`${ws}/demand/coverage`, (c) =>
    c.json({
      from: "2026-11-09",
      to: "2026-11-16",
      weeks: [],
      basis: { stock: true, production: true },
      rows: [],
    }),
  );

  app.get(`${ws}/demand/summary`, (c) => {
    const q = c.req.query();
    const from = q.from ? parsePeriod(q.from) : undefined;
    const to = q.to ? parsePeriod(q.to) : undefined;
    if (from === null || to === null) return c.json(err("invalid_input", "Bad period"), 400);
    const range = demandRange({ from, to }, today);
    if (!range) return c.json(err("invalid_input", "Choose a shorter range"), 400);
    const byCustomer = q.byCustomer === "true";
    const chosen = lines.filter((l) => {
      const item = itemOf(l.itemId);
      return (
        !l.deletedAt &&
        (!q.itemId || l.itemId === q.itemId) &&
        (!q.itemCode || item.code.toLowerCase() === q.itemCode.toLowerCase()) &&
        (!q.itemType || item.type === q.itemType)
      );
    });
    return c.json(
      buildDemandSummary({
        ...range,
        byCustomer,
        cells: chosen.map((l) => ({ ...l, lineCount: 1 }) as any),
        items: new Map(chosen.map((l) => [l.itemId, summary(itemOf(l.itemId)) as any])),
      }),
    );
  });

  app.get(`${ws}/demand/lines`, (c) => {
    const q = c.req.query();
    const from = q.from ? parsePeriod(q.from) : null;
    const to = q.to ? parsePeriod(q.to) : null;
    const found = lines
      .filter((l) => {
        const item = itemOf(l.itemId);
        return (
          !l.deletedAt &&
          (!q.itemId || l.itemId === q.itemId) &&
          (!q.itemCode || item.code.toLowerCase() === q.itemCode.toLowerCase()) &&
          (!from || l.periodStart >= from) &&
          (!to || l.periodStart <= to) &&
          (!q.customer || customerKey(l.customer) === customerKey(q.customer)) &&
          (!q.source || l.source === q.source) &&
          (!q.q || `${item.code} ${item.name}`.toLowerCase().includes(q.q.toLowerCase()))
        );
      })
      .sort(
        (a, b) =>
          a.periodStart.localeCompare(b.periodStart) ||
          itemOf(a.itemId).code.localeCompare(itemOf(b.itemId).code) ||
          customerKey(a.customer).localeCompare(customerKey(b.customer)),
      );
    const limit = Number(q.limit ?? 50);
    const offset = Number(q.offset ?? 0);
    return c.json({
      lines: found.slice(offset, offset + limit).map(view),
      total: found.length,
      limit,
      offset,
    });
  });

  app.put(`${ws}/demand/lines`, async (c) => {
    const parsed = demandLinesSetSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json(err("invalid_input", "Invalid input", parsed.error.issues), 400);
    const { errors, plan } = apply(demandEntriesFromInput(parsed.data), "api", null, false);
    if (errors.length) return c.json(invalid(errors), 400);
    return c.json({
      ...counts(plan),
      lines: plan.map(({ entry, current, action }) => {
        const line =
          current ??
          lines.find(
            (l) =>
              !l.deletedAt &&
              demandKey(l.itemId, l.periodStart, l.customer) ===
                demandKey(entry.item.id, entry.periodStart, entry.customer),
          );
        return { row: entry.row, action, line: line && !line.deletedAt ? view(line) : null };
      }),
    });
  });

  app.post(`${ws}/demand/imports`, async (c) => {
    const parsed = demandImportSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json(err("invalid_input", "Invalid input", parsed.error.issues), 400);
    const input = parsed.data;
    const csv = parseDemandCsv(input.csv);
    const dryRun = input.dryRun ?? false;
    const importId = dryRun ? null : newId();
    const applied = csv.errors.length
      ? { errors: csv.errors, plan: [], horizon: null }
      : apply(csv.entries, "import", importId, dryRun, input.replaceHorizon);
    if (applied.errors.length && !dryRun) return c.json(invalid(applied.errors), 400);
    const n = counts(applied.plan);
    const imported = importId
      ? {
          id: importId,
          fileName: input.fileName ?? null,
          rowCount: csv.rowCount,
          createdCount: n.created,
          updatedCount: n.updated,
          removedCount: n.removed,
          unchangedCount: n.unchanged,
          actorId: null,
          createdAt: now,
        }
      : null;
    if (imported) imports.push(imported);
    return c.json(
      {
        dryRun,
        fileName: input.fileName ?? null,
        rowCount: csv.rowCount,
        ignoredColumns: csv.ignoredColumns,
        errors: applied.errors,
        created: n.created,
        updated: n.updated,
        removed: n.removed,
        unchanged: n.unchanged,
        horizon: applied.horizon
          ? {
              ...applied.horizon,
              fromWeek: formatWeek(applied.horizon.from),
              toWeek: formatWeek(applied.horizon.to),
            }
          : null,
        changes: applied.plan
          .filter((p) => p.action !== "unchanged")
          .map(({ entry, current, action }) => ({
            row: entry.row,
            action,
            item: summary(entry.item),
            periodStart: entry.periodStart,
            week: formatWeek(entry.periodStart),
            customer: entry.customer,
            amount: entry.quantity === null ? null : stockAmount(entry.quantity, entry.item),
            previous: current ? stockAmount(current.quantity, entry.item) : null,
          })),
        changesTruncated: false,
        import: imported,
      },
      dryRun ? 200 : 201,
    );
  });

  return { products, lines, imports };
}
