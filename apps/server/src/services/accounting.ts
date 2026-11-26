import {
  accountingConnectionCreateSchema,
  accountingConnectionUpdateSchema,
  accountingMappingSchema,
} from "@knotworking/core";
import {
  accountingConnections as connections,
  accountingMappings as mappings,
  accountingConfigurationEvents as events,
  users,
  customers,
  suppliers,
  type Database,
  type Executor,
  type Transaction,
} from "@knotworking/db";
import { getTableColumns, and, asc, eq, ilike, ne, inArray, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { ApiError, notFound, badRequest } from "../errors";
import { executeLedgerCommand } from "./ledger-command";
const conflict = (message: string) => new ApiError(409, "accounting_conflict", message);
export async function findAccountingConnection(db: Executor, ws: string, id: string) {
  const [row] = await db
    .select()
    .from(connections)
    .where(and(eq(connections.workspaceId, ws), eq(connections.id, id)));
  if (!row) throw notFound("Accounting connection");
  return row;
}
export async function enabledAccountingMappings(db: Executor, ws: string, connectionId: string) {
  const rows = await db
    .select({
      kind: mappings.kind,
      localReference: mappings.localReference,
      externalReference: mappings.externalReference,
    })
    .from(mappings)
    .where(
      and(eq(mappings.workspaceId, ws), eq(mappings.connectionId, connectionId), eq(mappings.enabled, true)),
    );
  const byKind = (kind: string) =>
    new Map(rows.filter((r) => r.kind === kind).map((r) => [r.localReference, r.externalReference]));
  return {
    supplier: byKind("supplier"),
    customer: byKind("customer"),
    account: byKind("account"),
    tax: byKind("tax"),
  };
}

export async function assertAccountingConnection(
  db: Executor,
  ws: string,
  input: { connectionId: string; provider: string; companyId: string },
) {
  const row = await findAccountingConnection(db, ws, input.connectionId);
  if (!row.companyId) throw conflict("Set the accounting company before preparing or sending invoices");
  if (row.disabled) throw conflict("Accounting connection is disabled");
  if (row.provider !== input.provider || row.companyId !== input.companyId)
    throw conflict("Accounting destination does not match its configured connection");
  return row;
}
function reviewed(row: { revision: number }, expected: number) {
  if (row.revision !== expected) throw conflict("This setup changed. Reload and review its latest revision.");
}
export async function auditAccountingConfiguration(
  tx: Transaction,
  ws: string,
  connectionId: string,
  actorId: string,
  revision: number,
  action: string,
  reason: string,
  snapshot: Record<string, unknown>,
) {
  // Configuration and financial mappings are private; do not publish them to shared sync.
  await tx
    .insert(events)
    .values({ workspaceId: ws, connectionId, actorId, revision, action, reason, snapshot });
}
export async function listAccountingConnections(db: Database, ws: string, offset = 0) {
  const rows = await db
    .select()
    .from(connections)
    .where(eq(connections.workspaceId, ws))
    .orderBy(asc(connections.createdAt), asc(connections.id))
    .limit(51)
    .offset(offset);
  return { connections: rows.slice(0, 50), hasMore: rows.length > 50 };
}
export async function getAccountingConnection(
  db: Database,
  ws: string,
  id: string,
  readable = { suppliers: false, customers: false },
) {
  const connection = await findAccountingConnection(db, ws, id);
  const rows = await db
    .select()
    .from(mappings)
    .where(and(eq(mappings.workspaceId, ws), eq(mappings.connectionId, id)))
    .orderBy(asc(mappings.kind), asc(mappings.localReference))
    .limit(501);
  const labels = new Map<string, string>();
  for (const kind of ["supplier", "customer"] as const) {
    if (!(kind === "supplier" ? readable.suppliers : readable.customers)) continue;
    const ids = rows.filter((row) => row.kind === kind).map((row) => row.localReference);
    if (!ids.length) continue;
    const table = kind === "supplier" ? suppliers : customers;
    const sources = await db
      .select({ id: table.id, code: table.code, name: table.name })
      .from(table)
      .where(and(eq(table.workspaceId, ws), inArray(table.id, ids), isNull(table.deletedAt)));
    for (const source of sources)
      labels.set(`${kind}:${source.id}`, source.code ? `${source.code} · ${source.name}` : source.name);
  }
  return {
    connection,
    mappings: rows.slice(0, 500).map((row) => ({
      ...row,
      localLabel:
        row.kind === "supplier" || row.kind === "customer"
          ? (labels.get(`${row.kind}:${row.localReference}`) ?? "Local record unavailable")
          : row.localReference,
    })),
    mappingsTruncated: rows.length > 500,
  };
}
export async function accountingConfigurationHistory(db: Database, ws: string, id: string, offset = 0) {
  await findAccountingConnection(db, ws, id);
  const rows = await db
    .select({ ...getTableColumns(events), actorName: users.name })
    .from(events)
    .innerJoin(users, eq(users.id, events.actorId))
    .where(and(eq(events.workspaceId, ws), eq(events.connectionId, id)))
    .orderBy(asc(events.revision), asc(events.id))
    .limit(51)
    .offset(offset);
  return { events: rows.slice(0, 50), hasMore: rows.length > 50 };
}
export async function createAccountingConnection(
  db: Database,
  ws: string,
  actorId: string,
  input: z.infer<typeof accountingConnectionCreateSchema>,
) {
  return executeLedgerCommand(db, ws, actorId, "accounting.connection.create", input, input, async (tx) => {
    const [existing] = await tx
      .select({ id: connections.id })
      .from(connections)
      .where(
        and(
          eq(connections.workspaceId, ws),
          eq(connections.provider, input.provider),
          eq(connections.companyId, input.companyId),
        ),
      );
    if (existing) throw conflict("This provider and company already have a connection");
    const [row] = await tx
      .insert(connections)
      .values({
        workspaceId: ws,
        name: input.name,
        provider: input.provider,
        companyId: input.companyId,
        createdBy: actorId,
      })
      .returning();
    await auditAccountingConfiguration(
      tx,
      ws,
      row!.id,
      actorId,
      1,
      "created",
      "Optional accounting setup saved",
      {
        name: input.name,
        provider: input.provider,
        companyId: input.companyId,
        disabled: false,
      },
    );
    return row!;
  });
}
export async function updateAccountingConnection(
  db: Database,
  ws: string,
  actorId: string,
  id: string,
  input: z.infer<typeof accountingConnectionUpdateSchema>,
) {
  return executeLedgerCommand(
    db,
    ws,
    actorId,
    "accounting.connection.update",
    input,
    { id, ...input },
    async (tx) => {
      const row = await findAccountingConnection(tx, ws, id);
      reviewed(row, input.expectedRevision);
      if (row.companyId && row.companyId !== input.companyId)
        throw conflict("The accounting company is fixed. Create a separate connection for another company.");
      if (!row.companyId && input.companyId) {
        const [duplicate] = await tx
          .select({ id: connections.id })
          .from(connections)
          .where(
            and(
              eq(connections.workspaceId, ws),
              eq(connections.provider, row.provider),
              eq(connections.companyId, input.companyId),
              ne(connections.id, id),
            ),
          );
        if (duplicate) throw conflict("This provider and company already have a connection");
      }
      const [updated] = await tx
        .update(connections)
        .set({
          name: input.name,
          companyId: input.companyId,
          disabled: input.disabled,
          revision: row.revision + 1,
          updatedAt: new Date(),
        })
        .where(and(eq(connections.workspaceId, ws), eq(connections.id, id)))
        .returning();
      await auditAccountingConfiguration(tx, ws, id, actorId, row.revision + 1, "updated", input.reason, {
        name: input.name,
        provider: row.provider,
        companyId: input.companyId,
        disabled: input.disabled,
      });
      return updated!;
    },
  );
}
export async function saveAccountingMapping(
  db: Database,
  ws: string,
  actorId: string,
  id: string,
  input: z.infer<typeof accountingMappingSchema>,
) {
  return executeLedgerCommand(
    db,
    ws,
    actorId,
    "accounting.mapping.save",
    input,
    { id, ...input },
    async (tx) => {
      const connection = await findAccountingConnection(tx, ws, id);
      reviewed(connection, input.expectedRevision);
      if (input.kind === "supplier" || input.kind === "customer") {
        if (!z.uuid().safeParse(input.localReference).success)
          throw badRequest("Choose a local supplier or customer");
        const table = input.kind === "supplier" ? suppliers : customers;
        const [source] = await tx
          .select({ id: table.id })
          .from(table)
          .where(and(eq(table.workspaceId, ws), eq(table.id, input.localReference), isNull(table.deletedAt)));
        if (!source) throw notFound("Local account");
      }
      const [before] = await tx
        .select()
        .from(mappings)
        .where(
          and(
            eq(mappings.workspaceId, ws),
            eq(mappings.connectionId, id),
            eq(mappings.kind, input.kind),
            eq(mappings.localReference, input.localReference),
          ),
        );
      // Bound this first UI milestone; refuse overflow rather than silently hiding financial mappings.
      if (!before) {
        const existing = await tx
          .select({ id: mappings.id })
          .from(mappings)
          .where(and(eq(mappings.workspaceId, ws), eq(mappings.connectionId, id)))
          .limit(500);
        if (existing.length >= 500) throw conflict("This connection has reached the 500-mapping setup limit");
      }
      const values = {
        externalReference: input.externalReference,
        enabled: input.enabled,
        reviewedBy: actorId,
        reviewedAt: new Date(),
      };
      const [saved] = before
        ? await tx.update(mappings).set(values).where(eq(mappings.id, before.id)).returning()
        : await tx
            .insert(mappings)
            .values({
              workspaceId: ws,
              connectionId: id,
              kind: input.kind,
              localReference: input.localReference,
              ...values,
            })
            .returning();
      await tx
        .update(connections)
        .set({ revision: connection.revision + 1, updatedAt: new Date() })
        .where(and(eq(connections.workspaceId, ws), eq(connections.id, id)));
      await auditAccountingConfiguration(
        tx,
        ws,
        id,
        actorId,
        connection.revision + 1,
        "mapping_reviewed",
        input.reason,
        {
          kind: input.kind,
          localReference: input.localReference,
          before: before ? { externalReference: before.externalReference, enabled: before.enabled } : null,
          externalReference: input.externalReference,
          enabled: input.enabled,
        },
      );
      return saved!;
    },
  );
}
export async function accountingReferences(
  db: Database,
  ws: string,
  kind: "supplier" | "customer",
  q: string,
) {
  const table = kind === "supplier" ? suppliers : customers;
  const rows = await db
    .select({ id: table.id, code: table.code, name: table.name })
    .from(table)
    .where(
      and(
        eq(table.workspaceId, ws),
        isNull(table.deletedAt),
        q ? or(ilike(table.name, `%${q}%`), ilike(table.code, `%${q}%`)) : undefined,
      ),
    )
    .orderBy(asc(table.name), asc(table.id))
    .limit(101);
  return { references: rows.slice(0, 100), hasMore: rows.length > 100 };
}
