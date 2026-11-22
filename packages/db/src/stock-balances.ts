import { sql } from "drizzle-orm";
import type { Executor } from "./client";

export interface StockBalanceMismatch {
  lotId: string;
  locationId: string;
  ledger: number;
  stored: number;
}

/**
 * Compares `stock_balances` with the ledger it summarises and returns every lot and location where they
 * differ (an empty list means they agree). The trigger keeps them equal, so a mismatch means something
 * bypassed it (a restore that skipped triggers, a manual edit). Reads the whole ledger: for tests and
 * audits, not for request paths. Pass a workspace to limit the check.
 */
export async function reconcileStockBalances(
  db: Executor,
  workspaceId?: string,
): Promise<StockBalanceMismatch[]> {
  const ws = workspaceId ? sql`and workspace_id = ${workspaceId}` : sql``;
  const rows = await db.execute<{ lot_id: string; location_id: string; ledger: string; stored: string }>(sql`
    select coalesce(l.lot_id, b.lot_id) as lot_id, coalesce(l.location_id, b.location_id) as location_id,
           coalesce(l.qty, 0)::text as ledger, coalesce(b.quantity, 0)::text as stored
    from (select lot_id, location_id, sum(quantity) as qty from stock_movements where true ${ws}
          group by lot_id, location_id) l
    full outer join (select lot_id, location_id, quantity from stock_balances where true ${ws}) b
      on b.lot_id = l.lot_id and b.location_id = l.location_id
    where coalesce(l.qty, 0) <> coalesce(b.quantity, 0)`);
  const list = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? []);
  return (list as { lot_id: string; location_id: string; ledger: string; stored: string }[]).map((r) => ({
    lotId: r.lot_id,
    locationId: r.location_id,
    ledger: Number(r.ledger),
    stored: Number(r.stored),
  }));
}
