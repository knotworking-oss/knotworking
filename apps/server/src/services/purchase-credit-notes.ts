import {
  creditExcess,
  creditLineValue,
  creditNoteTotals,
  creditTotals,
  purchaseCreditNoteStatusLabels,
  purchaseInvoiceTotals,
  roundQuantity,
  type ApprovedCreditTotals,
  type PurchaseCreditLineInput,
  type PurchaseCreditNoteCreateInput,
  type PurchaseCreditNoteListQuery,
  type PurchaseCreditNoteUpdateInput,
  type PurchaseCreditNoteVoidInput,
} from "@knotworking/core";
import {
  items,
  lockWorkspaceLog,
  purchaseCreditNoteLines,
  purchaseCreditNotes,
  purchaseInvoiceLines,
  purchaseInvoices,
  purchaseOrderLines,
  purchaseOrders,
  recordChanges,
  suppliers,
  users,
  type ChangeInput,
  type Database,
  type Executor,
  type Transaction,
} from "@knotworking/db";
import { and, asc, count, desc, eq, gte, inArray, isNull, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { ApiError, badRequest, isPrimaryKeyViolation, notFound } from "../errors";
import { itemSummary } from "./ports/stock";

/**
 * Purchasing module: a supplier's credit notes, each its own document against one approved
 * invoice (see `@knotworking/core` purchase-credit-notes.ts).
 *
 * - Drafts are entered and edited by people and agents; approval is a person's (the route refuses
 *   tokens) and makes the credit note immutable; a wrong approved one is voided with a reason.
 * - Credits are capped by what was invoiced: per invoice line (value, and the quantity returned)
 *   and, over the whole invoice, its net. Only approved credit notes count towards a cap.
 * - Costing reads the approved credit lines of an order line (`approvedCreditLines`), so the invoice
 *   price a lot is costed at is net of its credits. Receipts are never touched.
 *
 * Every write takes the workspace lock and records its changes.
 */

type NoteRow = typeof purchaseCreditNotes.$inferSelect;
type NoteLineRow = typeof purchaseCreditNoteLines.$inferSelect;
type InvoiceRow = typeof purchaseInvoices.$inferSelect;

const like = (q: string) => `%${q.replace(/[!%_]/g, (ch) => `!${ch}`)}%`;
const ilike = (column: unknown, q: string) => sql`${column} ilike ${like(q)} escape '!'`;

const strip = <T extends { workspaceId: string; deletedAt: Date | null }>(row: T) => {
  const { workspaceId: _ws, deletedAt: _deleted, ...rest } = row;
  return rest;
};

const noteChange = (row: NoteRow): ChangeInput => ({
  entity: "purchase_credit_note",
  entityId: row.id,
  action: "upsert",
  data: strip(row),
});
const noteLineChange = (row: NoteLineRow): ChangeInput => ({
  entity: "purchase_credit_note_line",
  entityId: row.id,
  action: "upsert",
  data: strip(row),
});

// ─── Lookups ─────────────────────────────────────────────────────────────────

async function findNote(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(purchaseCreditNotes)
    .where(
      and(
        eq(purchaseCreditNotes.id, id),
        eq(purchaseCreditNotes.workspaceId, workspaceId),
        isNull(purchaseCreditNotes.deletedAt),
      ),
    );
  if (!row) throw notFound("Credit note");
  return row;
}

async function findInvoice(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(purchaseInvoices)
    .where(
      and(
        eq(purchaseInvoices.id, id),
        eq(purchaseInvoices.workspaceId, workspaceId),
        isNull(purchaseInvoices.deletedAt),
      ),
    );
  if (!row) throw notFound("Invoice");
  return row;
}

async function liveNoteLines(db: Executor, noteIds: string[]) {
  if (!noteIds.length) return [];
  return db
    .select()
    .from(purchaseCreditNoteLines)
    .where(
      and(inArray(purchaseCreditNoteLines.creditNoteId, noteIds), isNull(purchaseCreditNoteLines.deletedAt)),
    )
    .orderBy(asc(purchaseCreditNoteLines.lineNo), asc(purchaseCreditNoteLines.id));
}

async function userNames(db: Executor, ids: (string | null)[]) {
  const list = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  const rows = list.length
    ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, list))
    : [];
  const map = new Map(rows.map((r) => [r.id, r.name]));
  return (id: string | null) => (id ? (map.get(id) ?? null) : null);
}

const immutable = (note: NoteRow) =>
  new ApiError(
    409,
    "credit_note_not_draft",
    `Credit note ${note.creditNoteNumber} is ${purchaseCreditNoteStatusLabels[note.status].toLowerCase()}; it can't be changed`,
  );

// ─── Views ───────────────────────────────────────────────────────────────────

/** Credit notes with their lines, the invoice and supplier, and totals. */
async function loadNotes(db: Executor, notes: NoteRow[]) {
  const lines = await liveNoteLines(
    db,
    notes.map((n) => n.id),
  );
  const invoiceIds = [...new Set(notes.map((n) => n.invoiceId))];
  const supplierIds = [...new Set(notes.map((n) => n.supplierId))];
  const invoiceLineIds = [...new Set(lines.flatMap((l) => (l.invoiceLineId ? [l.invoiceLineId] : [])))];
  const [invoiceRows, supplierRows, invLines] = await Promise.all([
    invoiceIds.length
      ? db.select().from(purchaseInvoices).where(inArray(purchaseInvoices.id, invoiceIds))
      : [],
    supplierIds.length ? db.select().from(suppliers).where(inArray(suppliers.id, supplierIds)) : [],
    invoiceLineIds.length
      ? db
          .select({
            line: purchaseInvoiceLines,
            item: items,
            orderReference: purchaseOrders.reference,
            orderLineNo: purchaseOrderLines.lineNo,
          })
          .from(purchaseInvoiceLines)
          .leftJoin(items, eq(items.id, purchaseInvoiceLines.itemId))
          .leftJoin(purchaseOrders, eq(purchaseOrders.id, purchaseInvoiceLines.purchaseOrderId))
          .leftJoin(purchaseOrderLines, eq(purchaseOrderLines.id, purchaseInvoiceLines.orderLineId))
          .where(inArray(purchaseInvoiceLines.id, invoiceLineIds))
      : [],
  ]);
  const invoiceById = new Map(invoiceRows.map((i) => [i.id, i]));
  const supplierById = new Map(supplierRows.map((s) => [s.id, s]));
  const invLineById = new Map(invLines.map((r) => [r.line.id, r]));
  const linesByNote = new Map<string, NoteLineRow[]>();
  for (const l of lines) linesByNote.set(l.creditNoteId, [...(linesByNote.get(l.creditNoteId) ?? []), l]);
  const name = await userNames(
    db,
    notes.flatMap((n) => [n.createdBy, n.approvedBy, n.voidedBy]),
  );
  return notes.map((note) => {
    const lineViews = (linesByNote.get(note.id) ?? []).map((l) => {
      const inv = l.invoiceLineId ? invLineById.get(l.invoiceLineId) : undefined;
      return {
        id: l.id,
        lineNo: l.lineNo,
        kind: l.kind,
        reason: l.reason,
        quantity: l.quantity,
        unit: inv?.line.unit ?? null,
        unitPrice: l.unitPrice,
        value: creditLineValue(l.quantity, l.unitPrice),
        description: l.description,
        invoiceLine: inv
          ? {
              id: inv.line.id,
              lineNo: inv.line.lineNo,
              quantity: inv.line.quantity,
              unitPrice: inv.line.unitPrice,
              orderReference: inv.orderReference,
              item: inv.item ? itemSummary(inv.item) : null,
            }
          : null,
      };
    });
    const totals = creditNoteTotals(
      lineViews.map((l) => ({
        kind: l.kind,
        reason: l.reason,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
      })),
      note.vat,
    );
    const invoice = invoiceById.get(note.invoiceId)!;
    const supplier = supplierById.get(note.supplierId)!;
    return {
      note,
      lines: lineViews,
      summary: {
        ...strip(note),
        invoice: {
          id: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          version: invoice.version,
          status: invoice.status,
        },
        supplier: { id: supplier.id, name: supplier.name, code: supplier.code },
        net: totals.net,
        gross: totals.gross,
        linesCount: lineViews.length,
        createdByName: name(note.createdBy),
        approvedByName: name(note.approvedBy),
        voidedByName: name(note.voidedBy),
      },
    };
  });
}

export async function getCreditNote(db: Executor, workspaceId: string, id: string) {
  const note = await findNote(db, workspaceId, id);
  const [loaded] = await loadNotes(db, [note]);
  return { ...loaded!.summary, lines: loaded!.lines };
}

export async function listCreditNotes(db: Executor, workspaceId: string, query: PurchaseCreditNoteListQuery) {
  const cn = purchaseCreditNotes;
  const where: (SQL | undefined)[] = [eq(cn.workspaceId, workspaceId), isNull(cn.deletedAt)];
  if (query.status === "current") where.push(inArray(cn.status, ["draft", "approved"]));
  else if (query.status !== "all") where.push(eq(cn.status, query.status));
  if (query.supplierId) where.push(eq(cn.supplierId, query.supplierId));
  if (query.invoiceId) where.push(eq(cn.invoiceId, query.invoiceId));
  if (query.from) where.push(gte(cn.creditDate, query.from));
  if (query.to) where.push(lte(cn.creditDate, query.to));
  if (query.q) {
    where.push(
      or(
        ilike(cn.creditNoteNumber, query.q),
        ilike(suppliers.name, query.q),
        ilike(purchaseInvoices.invoiceNumber, query.q),
      ),
    );
  }
  const [rows, [total]] = await Promise.all([
    db
      .select({ note: cn })
      .from(cn)
      .innerJoin(suppliers, eq(suppliers.id, cn.supplierId))
      .innerJoin(purchaseInvoices, eq(purchaseInvoices.id, cn.invoiceId))
      .where(and(...where))
      .orderBy(desc(cn.creditDate), desc(cn.createdAt), desc(cn.id))
      .limit(query.limit)
      .offset(query.offset),
    db
      .select({ n: count() })
      .from(cn)
      .innerJoin(suppliers, eq(suppliers.id, cn.supplierId))
      .innerJoin(purchaseInvoices, eq(purchaseInvoices.id, cn.invoiceId))
      .where(and(...where)),
  ]);
  const loaded = await loadNotes(
    db,
    rows.map((r) => r.note),
  );
  return {
    creditNotes: loaded.map((l) => l.summary),
    total: total?.n ?? 0,
    limit: query.limit,
    offset: query.offset,
  };
}

// ─── Caps ────────────────────────────────────────────────────────────────────

/** Credited per invoice line by approved credit notes (other than `exceptNoteId`). */
async function creditedByInvoiceLine(db: Executor, invoiceLineIds: string[], exceptNoteId?: string) {
  const map = new Map<string, ApprovedCreditTotals>();
  if (!invoiceLineIds.length) return map;
  const rows = await db
    .select({ line: purchaseCreditNoteLines })
    .from(purchaseCreditNoteLines)
    .innerJoin(purchaseCreditNotes, eq(purchaseCreditNotes.id, purchaseCreditNoteLines.creditNoteId))
    .where(
      and(
        inArray(purchaseCreditNoteLines.invoiceLineId, invoiceLineIds),
        isNull(purchaseCreditNoteLines.deletedAt),
        eq(purchaseCreditNotes.status, "approved"),
        isNull(purchaseCreditNotes.deletedAt),
        exceptNoteId ? ne(purchaseCreditNotes.id, exceptNoteId) : undefined,
      ),
    );
  const by = new Map<string, NoteLineRow[]>();
  for (const { line } of rows) by.set(line.invoiceLineId!, [...(by.get(line.invoiceLineId!) ?? []), line]);
  for (const [id, list] of by) map.set(id, creditTotals(list));
  return map;
}

/**
 * A credit note can't credit more than the invoice billed: per invoice line (value and returned
 * quantity, with what approved credit notes already took) and over the invoice's net (charges
 * included). `409 over_credited` otherwise.
 */
async function assertWithinInvoice(
  tx: Executor,
  workspaceId: string,
  invoice: InvoiceRow,
  noteId: string | null,
  lines: readonly {
    kind: "invoice_line" | "charge";
    invoiceLineId: string | null;
    reason: "price" | "goods_returned" | null;
    quantity: number;
    unitPrice: number;
  }[],
) {
  const invLines = await tx
    .select()
    .from(purchaseInvoiceLines)
    .where(and(eq(purchaseInvoiceLines.invoiceId, invoice.id), isNull(purchaseInvoiceLines.deletedAt)));
  const byId = new Map(invLines.map((l) => [l.id, l]));
  const already = await creditedByInvoiceLine(
    tx,
    invLines.map((l) => l.id),
    noteId ?? undefined,
  );
  const adding = new Map<string, NoteLineRow[]>();
  for (const l of lines) {
    if (l.kind !== "invoice_line") continue;
    adding.set(l.invoiceLineId!, [...(adding.get(l.invoiceLineId!) ?? []), l as unknown as NoteLineRow]);
  }
  for (const [lineId, list] of adding) {
    const invLine = byId.get(lineId)!;
    const excess = creditExcess(
      invLine,
      already.get(lineId) ?? { value: 0, returnedQuantity: 0 },
      creditTotals(list),
    );
    if (excess) {
      throw new ApiError(
        409,
        "over_credited",
        excess === "value"
          ? `Invoice line ${invLine.lineNo} was billed ${creditLineValue(invLine.quantity, invLine.unitPrice)}; the credit notes would credit more than that`
          : `Invoice line ${invLine.lineNo} was billed ${invLine.quantity}; more than that can't be returned`,
        { invoiceLineId: lineId, excess },
      );
    }
  }
  // Over the whole invoice: its net, less what other approved credit notes took, covers this one.
  const others = await tx
    .select({ id: purchaseCreditNotes.id })
    .from(purchaseCreditNotes)
    .where(
      and(
        eq(purchaseCreditNotes.invoiceId, invoice.id),
        eq(purchaseCreditNotes.status, "approved"),
        isNull(purchaseCreditNotes.deletedAt),
        noteId ? ne(purchaseCreditNotes.id, noteId) : undefined,
      ),
    );
  const otherLines = await liveNoteLines(
    tx,
    others.map((o) => o.id),
  );
  const invoiceNet = purchaseInvoiceTotals(invLines, 0).net;
  const credited = roundQuantity(creditTotals(otherLines).value + creditTotals(lines).value, 4);
  if (credited > invoiceNet) {
    throw new ApiError(
      409,
      "over_credited",
      `Invoice ${invoice.invoiceNumber} totals ${invoiceNet} net; the credit notes would credit ${credited}`,
      { invoiceNet, credited },
    );
  }
  return invLines;
}

/** Lines checked against the invoice and ready to insert. */
async function lineValues(tx: Executor, invoice: InvoiceRow, input: readonly PurchaseCreditLineInput[]) {
  const invLines = await tx
    .select()
    .from(purchaseInvoiceLines)
    .where(and(eq(purchaseInvoiceLines.invoiceId, invoice.id), isNull(purchaseInvoiceLines.deletedAt)));
  const byId = new Map(invLines.map((l) => [l.id, l]));
  return input.map((line, index) => {
    const common = { lineNo: index + 1, quantity: roundQuantity(line.quantity), unitPrice: line.unitPrice };
    if (line.kind === "charge") {
      return {
        ...common,
        kind: "charge" as const,
        invoiceLineId: null,
        orderLineId: null,
        reason: null,
        description: line.description,
      };
    }
    const invLine = byId.get(line.invoiceLineId);
    if (!invLine || invLine.kind !== "order") {
      throw badRequest(`Line ${index + 1}: that isn't an order line of invoice ${invoice.invoiceNumber}`, {
        index,
      });
    }
    return {
      ...common,
      kind: "invoice_line" as const,
      invoiceLineId: invLine.id,
      orderLineId: invLine.orderLineId,
      reason: line.reason,
      description: line.description ?? null,
    };
  });
}

async function insertLines(
  tx: Transaction,
  workspaceId: string,
  creditNoteId: string,
  values: Awaited<ReturnType<typeof lineValues>>,
) {
  if (!values.length) return [];
  return tx
    .insert(purchaseCreditNoteLines)
    .values(values.map((v) => ({ ...v, workspaceId, creditNoteId })))
    .returning();
}

async function assertNumberFree(
  tx: Executor,
  workspaceId: string,
  supplierId: string,
  number: string,
  exceptId?: string,
) {
  const [taken] = await tx
    .select({ id: purchaseCreditNotes.id })
    .from(purchaseCreditNotes)
    .where(
      and(
        eq(purchaseCreditNotes.workspaceId, workspaceId),
        eq(purchaseCreditNotes.supplierId, supplierId),
        sql`lower(${purchaseCreditNotes.creditNoteNumber}) = lower(${number})`,
        isNull(purchaseCreditNotes.deletedAt),
        ne(purchaseCreditNotes.status, "voided"),
        exceptId ? ne(purchaseCreditNotes.id, exceptId) : undefined,
      ),
    )
    .limit(1);
  if (taken) {
    throw new ApiError(
      409,
      "duplicate_credit_note_number",
      `This supplier already has a credit note numbered ${number}`,
      { creditNoteId: taken.id },
    );
  }
}

/** Only an approved invoice (the version in force) can be credited. */
function assertCreditable(invoice: InvoiceRow) {
  if (invoice.status !== "approved") {
    throw new ApiError(
      409,
      "invoice_not_creditable",
      invoice.status === "draft"
        ? `Invoice ${invoice.invoiceNumber} is a draft; credit notes are against approved invoices`
        : `Invoice ${invoice.invoiceNumber} version ${invoice.version} has been superseded; credit the latest version`,
    );
  }
}

// ─── Entering drafts (people and agents) ─────────────────────────────────────

export async function createCreditNote(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: PurchaseCreditNoteCreateInput,
) {
  try {
    return await db.transaction(async (tx) => {
      await lockWorkspaceLog(tx, workspaceId);
      const invoice = await findInvoice(tx, workspaceId, input.invoiceId);
      assertCreditable(invoice);
      await assertNumberFree(tx, workspaceId, invoice.supplierId, input.creditNoteNumber);
      const values = await lineValues(tx, invoice, input.lines);
      await assertWithinInvoice(tx, workspaceId, invoice, null, values);
      const [note] = await tx
        .insert(purchaseCreditNotes)
        .values({
          ...(input.id ? { id: input.id } : {}),
          workspaceId,
          supplierId: invoice.supplierId,
          invoiceId: invoice.id,
          creditNoteNumber: input.creditNoteNumber,
          creditDate: input.creditDate,
          vat: input.vat,
          notes: input.notes ?? null,
          createdBy: actorId,
        })
        .returning();
      const lines = await insertLines(tx, workspaceId, note!.id, values);
      await recordChanges(tx, workspaceId, actorId, [noteChange(note!), ...lines.map(noteLineChange)]);
      return getCreditNote(tx, workspaceId, note!.id);
    });
  } catch (err) {
    if (input.id && isPrimaryKeyViolation(err)) {
      throw new ApiError(409, "conflict", "A credit note with this id already exists");
    }
    throw err;
  }
}

/** Edits a draft; `lines` replaces every line. Approved and voided credit notes can't change. */
export async function updateCreditNote(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  patch: PurchaseCreditNoteUpdateInput,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const current = await findNote(tx, workspaceId, id);
    if (current.status !== "draft") throw immutable(current);
    const { lines: lineInput, ...header } = patch;
    if (
      header.creditNoteNumber !== undefined &&
      header.creditNoteNumber.toLowerCase() !== current.creditNoteNumber.toLowerCase()
    ) {
      await assertNumberFree(tx, workspaceId, current.supplierId, header.creditNoteNumber, id);
    }
    const invoice = await findInvoice(tx, workspaceId, current.invoiceId);
    const changes: ChangeInput[] = [];
    if (lineInput) {
      assertCreditable(invoice);
      const values = await lineValues(tx, invoice, lineInput);
      await assertWithinInvoice(tx, workspaceId, invoice, id, values);
      const existing = await liveNoteLines(tx, [id]);
      if (existing.length) {
        await tx
          .update(purchaseCreditNoteLines)
          .set({ deletedAt: new Date() })
          .where(
            inArray(
              purchaseCreditNoteLines.id,
              existing.map((l) => l.id),
            ),
          );
        for (const l of existing)
          changes.push({ entity: "purchase_credit_note_line", entityId: l.id, action: "delete" });
      }
      changes.push(...(await insertLines(tx, workspaceId, id, values)).map(noteLineChange));
    }
    const [row] = await tx
      .update(purchaseCreditNotes)
      .set({ ...header, updatedAt: new Date() })
      .where(eq(purchaseCreditNotes.id, id))
      .returning();
    changes.unshift(noteChange(row!));
    await recordChanges(tx, workspaceId, actorId, changes);
    return getCreditNote(tx, workspaceId, id);
  });
}

/** Deletes a draft (soft). An approved credit note is voided instead. */
export async function deleteCreditNote(db: Database, workspaceId: string, actorId: string, id: string) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const current = await findNote(tx, workspaceId, id);
    if (current.status !== "draft") throw immutable(current);
    const now = new Date();
    const lines = await tx
      .update(purchaseCreditNoteLines)
      .set({ deletedAt: now })
      .where(and(eq(purchaseCreditNoteLines.creditNoteId, id), isNull(purchaseCreditNoteLines.deletedAt)))
      .returning({ id: purchaseCreditNoteLines.id });
    await tx.update(purchaseCreditNotes).set({ deletedAt: now }).where(eq(purchaseCreditNotes.id, id));
    await recordChanges(tx, workspaceId, actorId, [
      { entity: "purchase_credit_note", entityId: id, action: "delete" },
      ...lines.map((l): ChangeInput => ({
        entity: "purchase_credit_note_line",
        entityId: l.id,
        action: "delete",
      })),
    ]);
  });
}

// ─── Approval and voiding (a person) ─────────────────────────────────────────

/**
 * Approves a draft: a person's act with `manage` (the route refuses tokens). It needs a line, the
 * invoice still the one in force, and the credit still within what the invoice billed (other
 * credit notes may have been approved since it was entered). Immutable afterwards.
 */
export async function approveCreditNote(db: Database, workspaceId: string, actorId: string, id: string) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const current = await findNote(tx, workspaceId, id);
    if (current.status !== "draft") {
      throw new ApiError(
        409,
        "credit_note_not_draft",
        `Credit note ${current.creditNoteNumber} is already ${purchaseCreditNoteStatusLabels[current.status].toLowerCase()}`,
      );
    }
    const lines = await liveNoteLines(tx, [id]);
    if (!lines.length) throw badRequest("A credit note needs at least one line to be approved");
    const invoice = await findInvoice(tx, workspaceId, current.invoiceId);
    assertCreditable(invoice);
    await assertWithinInvoice(tx, workspaceId, invoice, id, lines);
    const now = new Date();
    const [row] = await tx
      .update(purchaseCreditNotes)
      .set({ status: "approved", approvedAt: now, approvedBy: actorId, updatedAt: now })
      .where(eq(purchaseCreditNotes.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [noteChange(row!)]);
    return getCreditNote(tx, workspaceId, id);
  });
}

/**
 * Voids an approved credit note entered in error: it no longer counts anywhere (costing included),
 * stays on record with who voided it and why, and its number can be used again.
 */
export async function voidCreditNote(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: PurchaseCreditNoteVoidInput,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const current = await findNote(tx, workspaceId, id);
    if (current.status !== "approved") {
      throw new ApiError(
        409,
        "credit_note_not_approved",
        current.status === "draft"
          ? `Credit note ${current.creditNoteNumber} is a draft; delete it instead`
          : `Credit note ${current.creditNoteNumber} has already been voided`,
      );
    }
    const now = new Date();
    const [row] = await tx
      .update(purchaseCreditNotes)
      .set({ status: "voided", voidedAt: now, voidedBy: actorId, voidReason: input.reason, updatedAt: now })
      .where(eq(purchaseCreditNotes.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [noteChange(row!)]);
    return getCreditNote(tx, workspaceId, id);
  });
}

// ─── Costing ─────────────────────────────────────────────────────────────────

/**
 * What costing reads: the credit lines of approved credit notes against these order lines (voided
 * notes left out). Costing aggregates them per order line with `creditTotals`.
 */
export async function approvedCreditLines(
  db: Executor,
  workspaceId: string,
  orderLineIds: readonly string[],
) {
  if (!orderLineIds.length) return [];
  return db
    .select({
      orderLineId: purchaseCreditNoteLines.orderLineId,
      kind: purchaseCreditNoteLines.kind,
      reason: purchaseCreditNoteLines.reason,
      quantity: purchaseCreditNoteLines.quantity,
      unitPrice: purchaseCreditNoteLines.unitPrice,
    })
    .from(purchaseCreditNoteLines)
    .innerJoin(purchaseCreditNotes, eq(purchaseCreditNotes.id, purchaseCreditNoteLines.creditNoteId))
    .where(
      and(
        eq(purchaseCreditNoteLines.workspaceId, workspaceId),
        inArray(purchaseCreditNoteLines.orderLineId, [...orderLineIds]),
        eq(purchaseCreditNoteLines.kind, "invoice_line"),
        isNull(purchaseCreditNoteLines.deletedAt),
        eq(purchaseCreditNotes.status, "approved"),
        isNull(purchaseCreditNotes.deletedAt),
      ),
    );
}
