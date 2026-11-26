import type { CustomerCreateInput, CustomerListQuery, CustomerUpdateInput } from "@knotworking/core";
import {
  customers,
  lockWorkspaceLog,
  recordChanges,
  type Database,
  type Executor,
  type Transaction,
} from "@knotworking/db";
import { and, asc, count, eq, isNull, ne, or, sql } from "drizzle-orm";
import { ApiError, notFound } from "../errors";

type Customer = typeof customers.$inferSelect;
const view = ({ workspaceId: _workspace, deletedAt: _deleted, ...row }: Customer) => row;
// Contact details and addresses are queried under customer access, never replicated to all clients.
const change = (row: Customer) => ({
  entity: "customer" as const,
  entityId: row.id,
  action: "upsert" as const,
  data: { id: row.id, code: row.code, name: row.name, status: row.status, updatedAt: row.updatedAt },
});

export async function findCustomer(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(customers)
    .where(and(eq(customers.workspaceId, workspaceId), eq(customers.id, id), isNull(customers.deletedAt)));
  if (!row) throw notFound("Customer");
  return row;
}
export const getCustomer = async (db: Executor, workspaceId: string, id: string) =>
  view(await findCustomer(db, workspaceId, id));

export async function listCustomers(db: Database, workspaceId: string, query: CustomerListQuery) {
  const escaped = `%${(query.q ?? "").replace(/[!%_]/g, (v) => `!${v}`)}%`;
  const where = and(
    eq(customers.workspaceId, workspaceId),
    isNull(customers.deletedAt),
    query.status === "all" ? undefined : eq(customers.status, query.status),
    query.q
      ? or(
          sql`${customers.code} ilike ${escaped} escape '!'`,
          sql`${customers.name} ilike ${escaped} escape '!'`,
        )
      : undefined,
  );
  const [rows, [total]] = await Promise.all([
    db
      .select()
      .from(customers)
      .where(where)
      .orderBy(asc(customers.name), asc(customers.id))
      .limit(query.limit)
      .offset(query.offset),
    db.select({ n: count() }).from(customers).where(where),
  ]);
  return { customers: rows.map(view), total: total?.n ?? 0, limit: query.limit, offset: query.offset };
}

async function assertCodeFree(tx: Transaction, workspaceId: string, code: string, except?: string) {
  const [taken] = await tx
    .select({ id: customers.id })
    .from(customers)
    .where(
      and(
        eq(customers.workspaceId, workspaceId),
        sql`lower(${customers.code}) = lower(${code})`,
        except ? ne(customers.id, except) : undefined,
      ),
    )
    .limit(1);
  if (taken) throw new ApiError(409, "code_taken", "Another customer already uses this code");
}

export async function createCustomer(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: CustomerCreateInput,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    return insertCustomer(tx, workspaceId, actorId, input);
  });
}

/** Adds a customer inside the caller's transaction, which must hold the workspace log lock. */
export async function insertCustomer(
  tx: Transaction,
  workspaceId: string,
  actorId: string,
  input: CustomerCreateInput,
) {
  await assertCodeFree(tx, workspaceId, input.code);
  const [row] = await tx
    .insert(customers)
    .values({ ...input, workspaceId })
    .returning();
  await recordChanges(tx, workspaceId, actorId, [change(row!)]);
  return view(row!);
}

export async function updateCustomer(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: CustomerUpdateInput,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await findCustomer(tx, workspaceId, id);
    if (input.code) await assertCodeFree(tx, workspaceId, input.code, id);
    const [row] = await tx
      .update(customers)
      .set(input)
      .where(and(eq(customers.workspaceId, workspaceId), eq(customers.id, id)))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [change(row!)]);
    return view(row!);
  });
}
