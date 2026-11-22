import { newId } from "@knotworking/core";
import {
  createDb,
  migrateDb,
  users,
  workspaces,
  items,
  stockLocations,
  stockLots,
  lockWorkspaceLog,
} from "@knotworking/db";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { setLotStatus } from "./services/stock";

/** Run against an isolated Postgres database: PGlite serializes transactions and cannot expose this race. */
describe.skipIf(!process.env.TEST_POSTGRES_URL)("QA/ledger concurrency on Postgres", () => {
  it("waits for the ledger lock before taking a QA row lock", async () => {
    const url = new URL(process.env.TEST_POSTGRES_URL!);
    const application = `teamflow-qa-${newId()}`;
    url.searchParams.set("application_name", application);
    const main = createDb(process.env.TEST_POSTGRES_URL),
      qa = createDb(url.toString());
    const userId = newId(),
      workspaceId = newId(),
      itemId = newId(),
      locationId = newId(),
      lotId = newId();
    let change: Promise<unknown> | undefined;
    try {
      await migrateDb(main);
      await main.db.insert(users).values({ id: userId, email: `${userId}@example.test`, name: "QA" });
      await main.db
        .insert(workspaces)
        .values({ id: workspaceId, slug: `qa-${workspaceId}`, name: "QA test" });
      await main.db
        .insert(items)
        .values({ id: itemId, workspaceId, code: "QA", name: "QA", type: "ingredient", unit: "kg" });
      await main.db.insert(stockLocations).values({ id: locationId, workspaceId, name: "Store" });
      await main.db
        .insert(stockLots)
        .values({ id: lotId, workspaceId, itemId, lotCode: "QA", receivedOn: "2026-01-01" });
      await main.db.transaction(async (tx) => {
        await lockWorkspaceLog(tx, workspaceId);
        change = setLotStatus(qa.db, workspaceId, userId, lotId, { status: "quarantine", note: "Hold" });
        void change.catch(() => {});
        await vi.waitFor(
          async () => {
            const rows = await main.db.execute(
              sql`select wait_event from pg_stat_activity where application_name = ${application} and wait_event = 'advisory'`,
            );
            expect(Array.isArray(rows) ? rows.length : 0).toBe(1);
          },
          { timeout: 5000, interval: 25 },
        );
        // Before the fix QA held this row and waited for our advisory lock: NOWAIT failed 55P03.
        await tx.execute(sql`select id from stock_lots where id = ${lotId} for update nowait`);
      });
      await change;
      const [lot] = await main.db.select().from(stockLots).where(eq(stockLots.id, lotId));
      expect(lot?.status).toBe("quarantine");
    } finally {
      await change?.catch(() => {});
      await main.db.delete(workspaces).where(eq(workspaces.id, workspaceId));
      await main.db.delete(users).where(eq(users.id, userId));
      await qa.close();
      await main.close();
    }
  }, 30_000);
});
