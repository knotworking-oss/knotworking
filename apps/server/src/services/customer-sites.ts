import { type DeliverySiteInput, type DeliverySite } from "@knotworking/core";
import {
  customerDeliverySites as sites,
  lockWorkspaceLog,
  recordChanges,
  type Database,
  type Executor,
} from "@knotworking/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { ApiError, notFound } from "../errors";
import { findCustomer } from "./customers";
const view = (s: typeof sites.$inferSelect): DeliverySite => ({
  id: s.id,
  customerId: s.customerId,
  code: s.code,
  name: s.name,
  address: s.address,
  contactName: s.contactName,
  email: s.email,
  phone: s.phone,
  status: s.status,
});
export async function findDeliverySite(db: Executor, ws: string, customerId: string, id: string) {
  const [s] = await db
    .select()
    .from(sites)
    .where(and(eq(sites.workspaceId, ws), eq(sites.customerId, customerId), eq(sites.id, id)));
  if (!s) throw notFound("Delivery site");
  return s;
}
export async function listDeliverySites(
  db: Executor,
  ws: string,
  customerId: string,
): Promise<{ sites: DeliverySite[] }> {
  await findCustomer(db, ws, customerId);
  return {
    sites: (
      await db
        .select()
        .from(sites)
        .where(and(eq(sites.workspaceId, ws), eq(sites.customerId, customerId)))
        .orderBy(asc(sites.code))
    ).map(view),
  };
}
export async function saveDeliverySite(
  db: Database,
  ws: string,
  actor: string,
  customerId: string,
  input: DeliverySiteInput,
  id?: string,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, ws);
    await findCustomer(tx, ws, customerId);
    if (id) await findDeliverySite(tx, ws, customerId, id);
    const [duplicate] = await tx
      .select({ id: sites.id })
      .from(sites)
      .where(
        and(
          eq(sites.workspaceId, ws),
          eq(sites.customerId, customerId),
          sql`lower(${sites.code}) = lower(${input.code})`,
        ),
      );
    if (duplicate && duplicate.id !== id)
      throw new ApiError(409, "site_code_taken", "This customer already has a site with that code");
    const values = {
      ...input,
      contactName: input.contactName ?? null,
      email: input.email ?? null,
      phone: input.phone ?? null,
    };
    const [row] = id
      ? await tx.update(sites).set(values).where(eq(sites.id, id)).returning()
      : await tx
          .insert(sites)
          .values({ workspaceId: ws, customerId, ...values })
          .returning();
    await recordChanges(tx, ws, actor, [
      { entity: "customer", entityId: customerId, action: "upsert", data: { id: customerId } },
    ]);
    return view(row!);
  });
}
