import {
  convertUnitPrice,
  currencyDigits,
  itemBaseUnit,
  newId,
  roundQuantity,
  salesLineValue,
  salesTotal,
  type SalesActionInput,
  type SalesCommitmentsQuery,
  type SalesCreateInput,
  type SalesDocumentInput,
  type SalesExternalInput,
  type SalesFulfilInput,
  type SalesListQuery,
  type SalesPageQuery,
  type SalesPriceInput,
  type SalesRecipientSnapshot,
  type SalesSaveInput,
} from "@knotworking/core";
import {
  salesOrders as orders,
  salesOrderLines as lines,
  salesPrices as prices,
  salesEvents as events,
  salesFulfilments as fulfilments,
  salesExternalReferences as references,
  despatches,
  despatchLines,
  customers,
  items,
  recordChanges,
  type Database,
  type Executor,
  type Transaction,
} from "@knotworking/db";
import { and, asc, count, desc, eq, gte, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import { ApiError, badRequest, notFound } from "../errors";
import { findCustomer } from "./customers";
import { findDeliverySite } from "./customer-sites";
import { findItem, toBase } from "./ports/stock";
import { assertInvoiceFulfilmentUnclaimed, reservedSalesLines } from "./invoice-sources";
import { executeLedgerCommand } from "./ledger-command";
import { workspaceToday } from "./time-zone";

type Order = typeof orders.$inferSelect;
type Line = typeof lines.$inferSelect;
const publicRow = <T extends { workspaceId: string }>({ workspaceId: _ws, ...row }: T) => row;
const conflict = (message: string) => new ApiError(409, "sales_conflict", message);
const change = (
  entity: "sales_order" | "sales_price" | "sales_external_reference",
  id: string,
  revision?: number,
) => ({
  entity,
  entityId: id,
  action: "upsert" as const,
  data: { id, ...(revision === undefined ? {} : { revision }) },
});
export async function findSalesOrder(db: Executor, ws: string, id: string) {
  const [row] = await db
    .select()
    .from(orders)
    .where(and(eq(orders.workspaceId, ws), eq(orders.id, id)));
  if (!row) throw notFound("Sales document");
  return row;
}
const orderLines = (db: Executor, ws: string, id: string) =>
  db
    .select()
    .from(lines)
    .where(and(eq(lines.workspaceId, ws), eq(lines.orderId, id), isNull(lines.removedAt)))
    .orderBy(asc(lines.position), asc(lines.id));
function reviewed(row: Order, revision: number) {
  if (row.revision !== revision)
    throw conflict("This document changed. Reload and review the latest revision.");
}
async function recipient(
  db: Executor,
  ws: string,
  input: SalesDocumentInput,
): Promise<SalesRecipientSnapshot> {
  const customer = await findCustomer(db, ws, input.customerId);
  if (customer.status !== "active") throw conflict("Choose an active customer");
  const site = input.deliverySiteId
    ? await findDeliverySite(db, ws, customer.id, input.deliverySiteId)
    : null;
  if (site?.status === "archived") throw conflict("Choose an active delivery site");
  return {
    code: customer.code,
    name: customer.name,
    address: customer.address,
    deliveryAddress: site?.address ?? customer.address,
    deliverySiteCode: site?.code ?? null,
    deliverySiteName: site?.name ?? null,
  };
}
async function saleItem(db: Executor, ws: string, id: string) {
  const item = await findItem(db, ws, id);
  if (item.status !== "active" || !["finished", "wip"].includes(item.type))
    throw conflict("Choose an active finished or WIP item");
  return item;
}
/**
 * Resolves a document's lines against the document (`input`) and, when saving, its current lines.
 *
 * - An existing line whose item, unit, quantity and date are all unchanged may keep an item that
 *   has since been archived; any other line needs an active, sellable item.
 * - On an amendment, an existing line with the same item and unit keeps its agreed price when the
 *   price is left out (a confirmed commitment isn't re-priced from today's agreement). On a draft, a
 *   blank price selects the agreement in force on the line's date, as for a new line.
 * - A kept price keeps its agreement link only while that agreement still applies to the line: the
 *   same customer, currency and item, valid on the line's date, giving the same price in the line's
 *   unit. Otherwise the link is dropped and the price stands as an explicit one.
 */
async function resolveLines(
  db: Executor,
  ws: string,
  input: SalesDocumentInput,
  saving: { existing: readonly Line[]; amend: boolean } = { existing: [], amend: false },
) {
  const resolved = [];
  for (const [position, line] of input.lines.entries()) {
    const old = line.id ? saving.existing.find((l) => l.id === line.id) : undefined;
    const quantity = roundQuantity(line.quantity);
    const sameLine = !!old && old.itemId === line.itemId && old.unit === line.unit;
    const unchanged = sameLine && old!.quantity === quantity && old!.dueOn === line.dueOn;
    const item = unchanged ? await findItem(db, ws, line.itemId) : await saleItem(db, ws, line.itemId);
    const baseQuantity = toBase(quantity, line.unit, item, { max: 1_000_000_000 });
    let unitPrice = line.unitPrice;
    let priceId: string | null = null;
    if (sameLine) {
      if (unitPrice === undefined && saving.amend) unitPrice = old!.unitPrice;
      if (unitPrice !== undefined && unitPrice === old!.unitPrice && old!.priceId) {
        const [agreed] = await db
          .select()
          .from(prices)
          .where(and(eq(prices.workspaceId, ws), eq(prices.id, old!.priceId)));
        const applies =
          !!agreed &&
          agreed.customerId === input.customerId &&
          agreed.currency === input.currency &&
          agreed.itemId === item.id &&
          agreed.validFrom <= line.dueOn &&
          (agreed.validTo === null || agreed.validTo >= line.dueOn) &&
          convertUnitPrice(agreed.unitPrice, agreed.unit, line.unit, item) === unitPrice;
        if (applies) priceId = old!.priceId;
      }
    }
    if (unitPrice === undefined) {
      const [price] = await db
        .select()
        .from(prices)
        .where(
          and(
            eq(prices.workspaceId, ws),
            eq(prices.customerId, input.customerId),
            eq(prices.itemId, item.id),
            eq(prices.currency, input.currency),
            isNull(prices.archivedAt),
            lte(prices.validFrom, line.dueOn),
            or(isNull(prices.validTo), gte(prices.validTo, line.dueOn)),
          ),
        );
      if (!price)
        throw conflict(`No price agreement for ${item.code} on ${line.dueOn}; enter an explicit price`);
      const converted = convertUnitPrice(price.unitPrice, price.unit, line.unit, item);
      if (converted === null) throw badRequest("The price unit cannot be converted to the order unit");
      unitPrice = converted;
      priceId = price.id;
    }
    if (unitPrice > 99_999_999) throw badRequest("Converted price is too large");
    resolved.push({
      id: line.id,
      position,
      itemId: item.id,
      itemCode: item.code,
      itemName: item.name,
      unit: line.unit,
      baseUnit: itemBaseUnit(item) as "g" | "ml" | "each",
      quantity,
      baseQuantity,
      unitPrice,
      priceId,
      dueOn: line.dueOn,
      note: line.note,
    });
  }
  return resolved;
}
async function snapshot(db: Executor, ws: string, id: string) {
  const row = await findSalesOrder(db, ws, id);
  const digits = currencyDigits(row.currency);
  const [converted] =
    row.kind === "quote"
      ? await db
          .select({ id: orders.id })
          .from(orders)
          .where(
            and(
              eq(orders.workspaceId, ws),
              eq(orders.sourceQuoteId, id),
              or(ne(orders.status, "cancelled"), isNotNull(orders.confirmedAt)),
            ),
          )
      : [];
  const pricedLines = (await orderLines(db, ws, id)).map((line) => ({
    ...publicRow(line),
    value: salesLineValue(line.quantity, line.unitPrice, digits),
  }));
  return {
    ...publicRow(row),
    convertedOrderId: converted?.id ?? null,
    lines: pricedLines,
    total: salesTotal(
      pricedLines.map((l) => l.value),
      digits,
    ),
  };
}
async function record(
  tx: Transaction,
  ws: string,
  actor: string,
  id: string,
  action: string,
  reason: string,
) {
  const result = await snapshot(tx, ws, id);
  await tx.insert(events).values({
    workspaceId: ws,
    orderId: id,
    revision: result.revision,
    action,
    reason,
    actorId: actor,
    snapshot: JSON.parse(JSON.stringify(result)),
  });
  await recordChanges(tx, ws, actor, [change("sales_order", id, result.revision)]);
  return result;
}

export async function createSalesOrder(db: Database, ws: string, actor: string, input: SalesCreateInput) {
  return executeLedgerCommand(db, ws, actor, "sales.create", input, input, async (tx) => {
    const dest = await recipient(tx, ws, input.document);
    const resolved = await resolveLines(tx, ws, input.document);
    // Client line UUIDs only identify existing lines; new lines are allocated by the owner API.
    if (resolved.some((l) => l.id)) throw badRequest("Omit line IDs when creating a document");
    const id = newId();
    const { lines: _lines, ...fields } = input.document;
    await tx.insert(orders).values({
      ...fields,
      workspaceId: ws,
      id,
      kind: input.kind,
      reference: `${input.kind === "quote" ? "SQ" : "SO"}-${id.slice(-12)}`,
      recipient: dest,
      createdBy: actor,
    });
    await tx
      .insert(lines)
      .values(resolved.map(({ id: _id, ...line }) => ({ ...line, workspaceId: ws, orderId: id })));
    return record(tx, ws, actor, id, "created", "Draft created");
  });
}

/** All amounts in the original base unit. A real return does not silently create a replacement order. */
async function fulfilmentTotals(db: Executor, ws: string, orderId: string) {
  const rows = await db
    .select({
      lineId: fulfilments.orderLineId,
      shipped: sql<number>`sum(${despatchLines.quantity})::float8`,
      returned: sql<number>`sum((select coalesce(sum(r.quantity), 0) from despatch_returns r
      where r.workspace_id = ${ws} and r.line_id = ${despatchLines.id} and r.voided_at is null))::float8`,
    })
    .from(fulfilments)
    .innerJoin(despatchLines, eq(despatchLines.id, fulfilments.despatchLineId))
    .innerJoin(despatches, eq(despatches.id, despatchLines.despatchId))
    .where(
      and(
        eq(fulfilments.workspaceId, ws),
        eq(fulfilments.orderId, orderId),
        isNull(fulfilments.voidedAt),
        eq(despatchLines.workspaceId, ws),
        eq(despatches.workspaceId, ws),
        eq(despatches.status, "confirmed"),
      ),
    )
    .groupBy(fulfilments.orderLineId);
  return {
    totals: new Map(rows.map((row) => [row.lineId, { shipped: row.shipped, returned: row.returned }])),
  };
}

export async function saveSalesOrder(
  db: Database,
  ws: string,
  actor: string,
  id: string,
  input: SalesSaveInput,
  amend = false,
) {
  return executeLedgerCommand(
    db,
    ws,
    actor,
    amend ? "sales.amend" : "sales.save",
    input,
    { id, ...input },
    async (tx) => {
      const row = await findSalesOrder(tx, ws, id);
      reviewed(row, input.expectedRevision);
      if (row.status !== (amend ? "confirmed" : "draft"))
        throw conflict(amend ? "Only confirmed orders can be amended" : "Only drafts can be edited");
      if (
        (amend || row.sourceQuoteId) &&
        (input.document.customerId !== row.customerId ||
          input.document.deliverySiteId !== row.deliverySiteId ||
          input.document.currency !== row.currency)
      )
        throw conflict(
          amend
            ? "Customer, delivery site and currency cannot change after confirmation; cancel the balance and create another order"
            : "Customer, delivery site and currency come from the quote this order was made from; cancel this draft and create a new order instead",
        );
      const dest = amend ? row.recipient : await recipient(tx, ws, input.document);
      if (amend) await recipient(tx, ws, input.document); // revalidate active master data; retain historical recipient
      const existing = await orderLines(tx, ws, id);
      const resolved = await resolveLines(tx, ws, input.document, { existing, amend });
      if (amend) {
        const reserved = await reservedSalesLines(
          tx,
          ws,
          existing.map((line) => line.id),
        );
        const replacements = new Map(resolved.map((line) => [line.id, line]));
        for (const old of existing) {
          if (!reserved.has(old.id)) continue;
          const line = replacements.get(old.id);
          if (
            !line ||
            line.quantity !== old.quantity ||
            line.baseQuantity !== old.baseQuantity ||
            line.unitPrice !== old.unitPrice ||
            line.itemId !== old.itemId ||
            line.unit !== old.unit
          )
            throw conflict(
              "A reserved sales line cannot be repriced, resized or removed. Discard its invoice draft or amend the remaining balance with a new line.",
            );
        }
      }
      // Live links to confirmed despatches; a link to a since-voided despatch no longer fixes the line.
      const allLinks = await tx
        .select({ lineId: fulfilments.orderLineId })
        .from(fulfilments)
        .innerJoin(despatchLines, eq(despatchLines.id, fulfilments.despatchLineId))
        .innerJoin(despatches, eq(despatches.id, despatchLines.despatchId))
        .where(
          and(
            eq(fulfilments.workspaceId, ws),
            eq(fulfilments.orderId, id),
            isNull(fulfilments.voidedAt),
            eq(despatches.status, "confirmed"),
          ),
        );
      const linked = new Set(allLinks.map((l) => l.lineId));
      const { totals } = await fulfilmentTotals(tx, ws, id);
      for (const line of resolved) {
        const old = line.id ? existing.find((l) => l.id === line.id) : null;
        if (line.id && !old) throw badRequest("Line ID does not belong to the current document");
        if (
          old &&
          linked.has(old.id) &&
          (old.itemId !== line.itemId ||
            old.unit !== line.unit ||
            // The item's conversion for this unit is unchanged (compared exactly, not as a ratio of rounded values).
            toBase(old.quantity, old.unit, await findItem(tx, ws, old.itemId), { max: 1_000_000_000 }) !==
              old.baseQuantity)
        )
          throw conflict("A linked line's item and unit conversion are fixed");
        if (old && line.baseQuantity < (totals.get(old.id)?.shipped ?? 0))
          throw conflict("Quantity cannot be reduced below recorded despatches");
      }
      // Links left on a line that is removed or changes item/unit can only point at voided
      // despatches (live ones block above): close them so no link refers to a line that isn't there.
      const closeStaleLinks = (lineId: string, why: string) =>
        tx
          .update(fulfilments)
          .set({ voidedAt: new Date(), voidedBy: actor, voidReason: why })
          .where(
            and(
              eq(fulfilments.workspaceId, ws),
              eq(fulfilments.orderLineId, lineId),
              isNull(fulfilments.voidedAt),
            ),
          );
      for (const old of existing) {
        const now = resolved.find((l) => l.id === old.id);
        if (!now) {
          if (linked.has(old.id)) throw conflict("Correct fulfilment links before removing a linked line");
          await closeStaleLinks(old.id, "Order line removed; its despatch had been voided");
          await tx.update(lines).set({ removedAt: new Date() }).where(eq(lines.id, old.id));
        } else if (now.itemId !== old.itemId || now.unit !== old.unit) {
          await closeStaleLinks(old.id, "Order line changed; its despatch had been voided");
        }
      }
      for (const line of resolved) {
        const { id: lineId, ...fields } = line;
        if (lineId)
          await tx
            .update(lines)
            .set(fields)
            .where(and(eq(lines.id, lineId), eq(lines.workspaceId, ws)));
        else await tx.insert(lines).values({ ...fields, workspaceId: ws, orderId: id });
      }
      const { lines: _lines, ...fields } = input.document;
      await tx
        .update(orders)
        .set({
          ...fields,
          recipient: dest,
          revision: row.revision + 1,
          updatedAt: new Date(),
          ...(amend ? { signedBy: actor, signedAt: new Date() } : {}),
        })
        .where(eq(orders.id, id));
      return record(tx, ws, actor, id, amend ? "amended" : "edited", input.reason);
    },
  );
}

export async function actOnSalesOrder(
  db: Database,
  ws: string,
  actor: string,
  id: string,
  input: SalesActionInput,
  action: "confirm" | "issue" | "cancel" | "convert",
) {
  return executeLedgerCommand(db, ws, actor, `sales.${action}`, input, { id, ...input }, async (tx) => {
    const row = await findSalesOrder(tx, ws, id);
    reviewed(row, input.expectedRevision);
    if (action === "cancel") {
      if (row.status === "cancelled") throw conflict("Already cancelled");
    } else if (action === "convert") {
      if (row.kind !== "quote" || row.status !== "issued")
        throw conflict("Issue a quote before converting it");
      if (row.validUntil && row.validUntil < (await workspaceToday(tx, ws)))
        throw conflict("This quote has expired");
      const [already] = await tx
        .select({ id: orders.id })
        .from(orders)
        .where(
          and(
            eq(orders.workspaceId, ws),
            eq(orders.sourceQuoteId, id),
            or(ne(orders.status, "cancelled"), isNotNull(orders.confirmedAt)),
          ),
        );
      // An order cancelled while still a draft doesn't count: the quote can be converted again. One
      // that was ever confirmed does, so a cancelled balance can't be re-ordered from the same quote.
      if (already) throw conflict("This quote already has an order");
    } else if (row.status !== "draft" || row.kind !== (action === "issue" ? "quote" : "order"))
      throw conflict("The document is not in a valid state for this action");
    if (action !== "cancel" && action !== "convert") {
      const doc = await snapshot(tx, ws, id);
      const dest = await recipient(tx, ws, { ...doc, lines: [] });
      if (
        Object.entries(dest).some(
          ([key, value]) => row.recipient[key as keyof SalesRecipientSnapshot] !== value,
        )
      )
        throw conflict("Customer or delivery details changed; save a fresh draft and review it");
      for (const line of doc.lines) {
        const item = await saleItem(tx, ws, line.itemId);
        if (
          item.code !== line.itemCode ||
          item.name !== line.itemName ||
          itemBaseUnit(item) !== line.baseUnit ||
          toBase(line.quantity, line.unit, item, { max: 1_000_000_000 }) !== line.baseQuantity
        )
          throw conflict("An item changed; save a fresh draft and review it");
      }
      if (row.kind === "quote" && row.validUntil && row.validUntil < (await workspaceToday(tx, ws)))
        throw conflict("This quote has expired");
    }
    if (action === "convert") {
      const newOrderId = newId();
      const {
        id: _id,
        workspaceId: _ws,
        reference: _reference,
        revision: _revision,
        status: _status,
        kind: _kind,
        sourceQuoteId: _source,
        createdBy: _by,
        createdAt: _at,
        updatedAt: _update,
        signedAt: _signed,
        signedBy: _signer,
        ...fields
      } = row;
      await tx.insert(orders).values({
        ...fields,
        workspaceId: ws,
        id: newOrderId,
        reference: `SO-${newOrderId.slice(-12)}`,
        kind: "order",
        sourceQuoteId: id,
        createdBy: actor,
      });
      await tx.insert(lines).values(
        (await orderLines(tx, ws, id)).map(({ id: _lineId, orderId: _order, ...line }) => ({
          ...line,
          orderId: newOrderId,
        })),
      );
      // Record conversion on the quote too, so stale readers cannot convert it twice.
      await tx
        .update(orders)
        .set({ revision: row.revision + 1, updatedAt: new Date() })
        .where(eq(orders.id, id));
      await record(tx, ws, actor, id, "converted", input.reason);
      return record(tx, ws, actor, newOrderId, "created_from_quote", input.reason);
    }
    await tx
      .update(orders)
      .set({
        status: action === "cancel" ? "cancelled" : action === "issue" ? "issued" : "confirmed",
        ...(action === "confirm" ? { confirmedAt: new Date() } : {}),
        revision: row.revision + 1,
        updatedAt: new Date(),
        signedBy: actor,
        signedAt: new Date(),
      })
      .where(eq(orders.id, id));
    return record(tx, ws, actor, id, action, input.reason);
  });
}

export async function listSalesOrders(db: Database, ws: string, q: SalesListQuery) {
  const where = and(
    eq(orders.workspaceId, ws),
    q.customerId ? eq(orders.customerId, q.customerId) : undefined,
    q.kind ? eq(orders.kind, q.kind) : undefined,
    q.status ? eq(orders.status, q.status) : undefined,
  );
  const [rows, [total]] = await Promise.all([
    db
      .select()
      .from(orders)
      .where(where)
      .orderBy(desc(orders.createdAt), desc(orders.id))
      .limit(q.limit)
      .offset(q.offset),
    db.select({ n: count() }).from(orders).where(where),
  ]);
  return { orders: rows.map(publicRow), total: total!.n, limit: q.limit, offset: q.offset };
}
export async function getSalesOrder(db: Database, ws: string, id: string) {
  return db.transaction(async (tx) => snapshot(tx, ws, id), {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });
}
export async function salesHistory(db: Database, ws: string, id: string, q: SalesPageQuery) {
  await findSalesOrder(db, ws, id);
  const where = and(eq(events.workspaceId, ws), eq(events.orderId, id));
  const [rows, [total]] = await Promise.all([
    db.select().from(events).where(where).orderBy(desc(events.revision)).limit(q.limit).offset(q.offset),
    db.select({ n: count() }).from(events).where(where),
  ]);
  return { events: rows.map(publicRow), total: total!.n, ...q };
}

export async function createSalesPrice(db: Database, ws: string, actor: string, input: SalesPriceInput) {
  return executeLedgerCommand(db, ws, actor, "sales.price", input, input, async (tx) => {
    const customer = await findCustomer(tx, ws, input.customerId);
    if (customer.status !== "active") throw conflict("Choose an active customer");
    const item = await saleItem(tx, ws, input.itemId);
    toBase(1, input.unit, item);
    const [overlap] = await tx
      .select({ id: prices.id })
      .from(prices)
      .where(
        and(
          eq(prices.workspaceId, ws),
          eq(prices.customerId, input.customerId),
          eq(prices.itemId, input.itemId),
          eq(prices.currency, input.currency),
          isNull(prices.archivedAt),
          lte(prices.validFrom, input.validTo ?? "9999-12-31"),
          or(isNull(prices.validTo), gte(prices.validTo, input.validFrom)),
        ),
      );
    if (overlap)
      throw conflict(
        "An active price already covers part of this date range; archive it before replacing it",
      );
    const { commandId: _command, ...fields } = input;
    const [row] = await tx
      .insert(prices)
      .values({ ...fields, workspaceId: ws, createdBy: actor })
      .returning();
    await recordChanges(tx, ws, actor, [change("sales_price", row!.id)]);
    return publicRow(row!);
  });
}
export async function listSalesPrices(db: Database, ws: string, q: SalesPageQuery) {
  const where = eq(prices.workspaceId, ws);
  const [rows, [total]] = await Promise.all([
    db
      .select({
        price: prices,
        customerName: customers.name,
        customerCode: customers.code,
        itemCode: items.code,
        itemName: items.name,
      })
      .from(prices)
      .innerJoin(customers, eq(customers.id, prices.customerId))
      .innerJoin(items, eq(items.id, prices.itemId))
      .where(where)
      .orderBy(desc(prices.createdAt), desc(prices.id))
      .limit(q.limit)
      .offset(q.offset),
    db.select({ n: count() }).from(prices).where(where),
  ]);
  return {
    prices: rows.map(({ price, ...labels }) => ({ ...publicRow(price), ...labels })),
    total: total!.n,
    ...q,
  };
}
export async function archiveSalesPrice(
  db: Database,
  ws: string,
  actor: string,
  id: string,
  input: { commandId: string; reason: string },
) {
  return executeLedgerCommand(db, ws, actor, "sales.price.archive", input, { id, ...input }, async (tx) => {
    const [row] = await tx
      .select()
      .from(prices)
      .where(and(eq(prices.workspaceId, ws), eq(prices.id, id)));
    if (!row) throw notFound("Price agreement");
    if (row.archivedAt) throw conflict("Already archived");
    const [next] = await tx
      .update(prices)
      .set({ archivedAt: new Date(), archivedBy: actor, archiveReason: input.reason })
      .where(eq(prices.id, id))
      .returning();
    await recordChanges(tx, ws, actor, [change("sales_price", id)]);
    return publicRow(next!);
  });
}

export async function getSalesFulfilments(
  db: Database,
  ws: string,
  id: string,
  q: SalesPageQuery = { limit: 50, offset: 0 },
) {
  return db.transaction(
    async (tx) => {
      const row = await snapshot(tx, ws, id);
      const { totals } = await fulfilmentTotals(tx, ws, id);
      const where = and(eq(fulfilments.workspaceId, ws), eq(fulfilments.orderId, id));
      const rows = await tx
        .select({ link: fulfilments, delivery: despatchLines, despatch: despatches })
        .from(fulfilments)
        .innerJoin(despatchLines, eq(despatchLines.id, fulfilments.despatchLineId))
        .innerJoin(despatches, eq(despatches.id, despatchLines.despatchId))
        .where(and(where, eq(despatchLines.workspaceId, ws), eq(despatches.workspaceId, ws)))
        .orderBy(desc(fulfilments.createdAt), desc(fulfilments.id))
        .limit(q.limit)
        .offset(q.offset);
      const [total] = await tx.select({ n: count() }).from(fulfilments).where(where);
      return {
        lines: row.lines.map((l) => ({
          id: l.id,
          baseUnit: l.baseUnit,
          ordered: l.baseQuantity,
          shipped: totals.get(l.id)?.shipped ?? 0,
          returned: totals.get(l.id)?.returned ?? 0,
          outstanding:
            row.status === "cancelled"
              ? 0
              : roundQuantity(Math.max(0, l.baseQuantity - (totals.get(l.id)?.shipped ?? 0))),
        })),
        total: total!.n,
        ...q,
        links: rows.map((r) => ({
          ...publicRow(r.link),
          despatchId: r.despatch.id,
          despatchReference: r.despatch.reference,
          status: r.despatch.status,
          quantity: r.delivery.quantity,
          despatchedOn: r.despatch.despatchedOn,
        })),
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
export async function linkSalesFulfilment(
  db: Database,
  ws: string,
  actor: string,
  id: string,
  input: SalesFulfilInput,
) {
  return executeLedgerCommand(db, ws, actor, "sales.fulfil", input, { id, ...input }, async (tx) => {
    const order = await findSalesOrder(tx, ws, id);
    reviewed(order, input.expectedRevision);
    if (order.kind !== "order" || order.status !== "confirmed")
      throw conflict("Confirm an order before linking deliveries");
    const line = (await orderLines(tx, ws, id)).find((l) => l.id === input.orderLineId);
    if (!line) throw notFound("Order line");
    const [delivery] = await tx
      .select({ line: despatchLines, header: despatches })
      .from(despatchLines)
      .innerJoin(despatches, eq(despatches.id, despatchLines.despatchId))
      .where(
        and(
          eq(despatchLines.workspaceId, ws),
          eq(despatches.workspaceId, ws),
          eq(despatchLines.id, input.despatchLineId),
        ),
      );
    if (!delivery) throw notFound("Despatch line");
    if (
      delivery.header.status !== "confirmed" ||
      delivery.header.customerId !== order.customerId ||
      delivery.header.deliverySiteId !== order.deliverySiteId ||
      delivery.line.itemId !== line.itemId ||
      itemBaseUnit({ unit: delivery.line.itemUnit }) !== line.baseUnit
    )
      throw conflict("Delivery must be confirmed for this customer, site, item and base unit");
    const [linked] = await tx
      .select({ id: fulfilments.id })
      .from(fulfilments)
      .where(
        and(
          eq(fulfilments.workspaceId, ws),
          eq(fulfilments.despatchLineId, input.despatchLineId),
          isNull(fulfilments.voidedAt),
        ),
      );
    if (linked) throw conflict("This despatch line is already assigned to an order");
    await assertInvoiceFulfilmentUnclaimed(tx, ws, input.despatchLineId, line.id, false);
    const { totals } = await fulfilmentTotals(tx, ws, id);
    if (roundQuantity((totals.get(line.id)?.shipped ?? 0) + delivery.line.quantity) > line.baseQuantity)
      throw conflict("Delivery exceeds the remaining order quantity; amend the order first");
    await tx.insert(fulfilments).values({
      workspaceId: ws,
      orderId: id,
      orderLineId: line.id,
      despatchLineId: input.despatchLineId,
      reason: input.reason,
      createdBy: actor,
    });
    await tx
      .update(orders)
      .set({ revision: order.revision + 1, updatedAt: new Date() })
      .where(eq(orders.id, id));
    return record(tx, ws, actor, id, "delivery_linked", input.reason);
  });
}
export async function unlinkSalesFulfilment(
  db: Database,
  ws: string,
  actor: string,
  id: string,
  linkId: string,
  input: SalesActionInput,
) {
  return executeLedgerCommand(
    db,
    ws,
    actor,
    "sales.fulfil.void",
    input,
    { id, linkId, ...input },
    async (tx) => {
      const order = await findSalesOrder(tx, ws, id);
      reviewed(order, input.expectedRevision);
      // Links can't be added to a cancelled order, so its delivery evidence can't be removed either.
      if (order.status === "cancelled") throw conflict("A cancelled order's delivery links are retained");
      const [link] = await tx
        .select()
        .from(fulfilments)
        .where(and(eq(fulfilments.workspaceId, ws), eq(fulfilments.orderId, id), eq(fulfilments.id, linkId)));
      if (!link) throw notFound("Fulfilment link");
      if (link.voidedAt) throw conflict("This link is already corrected");
      await assertInvoiceFulfilmentUnclaimed(tx, ws, link.despatchLineId, link.orderLineId, true);
      await tx
        .update(fulfilments)
        .set({ voidedAt: new Date(), voidedBy: actor, voidReason: input.reason })
        .where(eq(fulfilments.id, linkId));
      await tx
        .update(orders)
        .set({ revision: order.revision + 1, updatedAt: new Date() })
        .where(eq(orders.id, id));
      return record(tx, ws, actor, id, "delivery_link_corrected", input.reason);
    },
  );
}

/** Deliberately separate from weekly forecasts. No copying or summing with forecast demand. */
export async function salesCommitments(db: Database, ws: string, q: SalesCommitmentsQuery) {
  const where = and(
    eq(lines.workspaceId, ws),
    eq(orders.workspaceId, ws),
    eq(orders.kind, "order"),
    eq(orders.status, "confirmed"),
    isNull(lines.removedAt),
    gte(lines.dueOn, q.from),
    lte(lines.dueOn, q.to),
  );
  return db.transaction(
    async (tx) => {
      const rows = await tx
        .select({ line: lines, order: orders })
        .from(lines)
        .innerJoin(orders, eq(orders.id, lines.orderId))
        .where(where)
        .orderBy(asc(lines.dueOn), asc(orders.id), asc(lines.position))
        .limit(q.limit)
        .offset(q.offset);
      const [total] = await tx
        .select({ n: count() })
        .from(lines)
        .innerJoin(orders, eq(orders.id, lines.orderId))
        .where(where);
      const totals = new Map<string, Awaited<ReturnType<typeof fulfilmentTotals>>["totals"]>();
      for (const id of new Set(rows.map((r) => r.order.id)))
        totals.set(id, (await fulfilmentTotals(tx, ws, id)).totals);
      return {
        basis: "confirmed_sales_orders_only" as const,
        forecastIncluded: false as const,
        lines: rows.map(({ line, order }) => ({
          orderId: order.id,
          reference: order.reference,
          lineId: line.id,
          customerId: order.customerId,
          customerName: order.recipient.name,
          itemId: line.itemId,
          itemCode: line.itemCode,
          itemName: line.itemName,
          dueOn: line.dueOn,
          baseUnit: line.baseUnit,
          ordered: line.baseQuantity,
          outstanding: roundQuantity(
            Math.max(0, line.baseQuantity - (totals.get(order.id)?.get(line.id)?.shipped ?? 0)),
          ),
        })),
        total: total!.n,
        ...q,
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

export async function listSalesReferences(db: Database, ws: string, q: SalesPageQuery) {
  const [rows, [total]] = await Promise.all([
    db
      .select()
      .from(references)
      .where(eq(references.workspaceId, ws))
      .orderBy(desc(references.createdAt), desc(references.id))
      .limit(q.limit)
      .offset(q.offset),
    db.select({ n: count() }).from(references).where(eq(references.workspaceId, ws)),
  ]);
  return {
    ownership: "teamflow" as const,
    contractVersion: 1,
    references: rows.map(publicRow),
    total: total!.n,
    ...q,
  };
}
export async function mapSalesReference(db: Database, ws: string, actor: string, input: SalesExternalInput) {
  return executeLedgerCommand(db, ws, actor, "sales.external.map", input, input, async (tx) => {
    if (input.entityType === "order") await findSalesOrder(tx, ws, input.entityId);
    if (input.entityType === "customer") await findCustomer(tx, ws, input.entityId);
    if (input.entityType === "item") await findItem(tx, ws, input.entityId);
    if (input.entityType === "price") {
      const [row] = await tx
        .select({ id: prices.id })
        .from(prices)
        .where(and(eq(prices.workspaceId, ws), eq(prices.id, input.entityId)));
      if (!row) throw notFound("Price agreement");
    }
    const existing = await tx
      .select()
      .from(references)
      .where(
        and(
          eq(references.workspaceId, ws),
          eq(references.system, input.system),
          eq(references.entityType, input.entityType),
          or(eq(references.externalId, input.externalId), eq(references.entityId, input.entityId)),
        ),
      );
    if (existing.length) {
      const row = existing[0]!;
      if (row.externalId === input.externalId && row.entityId === input.entityId) return publicRow(row);
      throw conflict("External reference is already mapped; reconcile it before changing ownership");
    }
    const { commandId: _command, ...fields } = input;
    const [row] = await tx
      .insert(references)
      .values({ ...fields, workspaceId: ws, createdBy: actor })
      .returning();
    await recordChanges(tx, ws, actor, [change("sales_external_reference", row!.id)]);
    return publicRow(row!);
  });
}
