import { readFileSync } from "node:fs";
import { newId } from "@knotworking/core";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb } from "./client";
import { migrationsFolder } from "./migrate";
import { reconcileStockBalances } from "./stock-balances";
import { stockBalances, stockMovements } from "./schema";

describe("stock balances migration", () => {
  it("fills balances from the existing ledger, then the trigger keeps them equal", async () => {
    const handle = createDb("memory://");
    try {
      const journal = JSON.parse(readFileSync(`${migrationsFolder}/meta/_journal.json`, "utf8")) as {
        entries: { tag: string }[];
      };
      const apply = async (tag: string) => {
        for (const statement of readFileSync(`${migrationsFolder}/${tag}.sql`, "utf8").split(
          "--> statement-breakpoint",
        )) {
          if (statement.trim()) await handle.db.execute(sql.raw(statement));
        }
      };
      for (const { tag } of journal.entries) {
        if (tag === "0084_stock_balances") break;
        await apply(tag);
      }
      const [userId, workspaceId, itemId, store, chill, lotA, lotB, lotC] = Array.from({ length: 8 }, () =>
        newId(),
      ) as [string, string, string, string, string, string, string, string];
      const run = (q: ReturnType<typeof sql>) => handle.db.execute(q);
      await run(sql`insert into users (id, email, name) values (${userId}, 'bal@example.test', 'Bal')`);
      await run(sql`insert into workspaces (id, slug, name) values (${workspaceId}, 'bal', 'Bal')`);
      await run(
        sql`insert into items (id, workspace_id, code, name, type, unit) values (${itemId}, ${workspaceId}, 'F', 'Flour', 'ingredient', 'kg')`,
      );
      for (const [id, name] of [
        [store, "Store"],
        [chill, "Chiller"],
      ] as const)
        await run(
          sql`insert into stock_locations (id, workspace_id, name) values (${id}, ${workspaceId}, ${name})`,
        );
      for (const [id, code] of [
        [lotA, "A"],
        [lotB, "B"],
        [lotC, "C"],
      ] as const)
        await run(
          sql`insert into stock_lots (id, workspace_id, item_id, lot_code, received_on) values (${id}, ${workspaceId}, ${itemId}, ${code}, '2026-01-01')`,
        );
      const move = (lot: string, loc: string, qty: number, type: string) =>
        run(
          sql`insert into stock_movements (id, workspace_id, lot_id, item_id, location_id, quantity, type) values (${newId()}, ${workspaceId}, ${lot}, ${itemId}, ${loc}, ${qty}, ${type})`,
        );
      await move(lotA, store, 100000, "receipt");
      await move(lotA, store, -30000, "consumption");
      await move(lotA, store, -20000, "transfer_out");
      await move(lotA, chill, 20000, "transfer_in");
      await move(lotB, store, 5000, "receipt");
      await move(lotB, store, -5000, "waste"); // drained: a zero balance row
      // Each movement fits numeric(18,4), but their aggregate does not.
      await move(lotC, store, 60_000_000_000_000, "receipt");
      await move(lotC, store, 60_000_000_000_000, "adjustment");

      // The migrator applies pending migrations in one transaction; so must this (LOCK TABLE needs one).
      await handle.db.transaction(async (tx) => {
        for (const statement of readFileSync(`${migrationsFolder}/0084_stock_balances.sql`, "utf8").split(
          "--> statement-breakpoint",
        ))
          if (statement.trim()) await tx.execute(sql.raw(statement));
      });
      const rows = await handle.db
        .select()
        .from(stockBalances)
        .where(eq(stockBalances.workspaceId, workspaceId));
      const at = (lot: string, loc: string) =>
        rows.find((r) => r.lotId === lot && r.locationId === loc)?.quantity;
      expect(at(lotA, store)).toBe(50000);
      expect(at(lotA, chill)).toBe(20000);
      expect(at(lotB, store)).toBe(0);
      expect(at(lotC, store)).toBe(120_000_000_000_000);
      expect(await reconcileStockBalances(handle.db)).toEqual([]);

      // New movements, including several in one statement, update the balances in step.
      await handle.db.insert(stockMovements).values([
        { workspaceId, lotId: lotA, itemId, locationId: store, quantity: -1000, type: "consumption" },
        { workspaceId, lotId: lotA, itemId, locationId: store, quantity: -2000, type: "consumption" },
        { workspaceId, lotId: lotB, itemId, locationId: chill, quantity: 700, type: "receipt" },
        {
          workspaceId,
          lotId: lotC,
          itemId,
          locationId: store,
          quantity: 60_000_000_000_000,
          type: "adjustment",
        },
      ]);
      const after = await handle.db
        .select()
        .from(stockBalances)
        .where(eq(stockBalances.workspaceId, workspaceId));
      expect(after.find((r) => r.lotId === lotA && r.locationId === store)?.quantity).toBe(47000);
      expect(after.find((r) => r.lotId === lotB && r.locationId === chill)?.quantity).toBe(700);
      expect(after.find((r) => r.lotId === lotC && r.locationId === store)?.quantity).toBe(
        180_000_000_000_000,
      );
      expect(await reconcileStockBalances(handle.db, workspaceId)).toEqual([]);

      // A balance that no longer matches the ledger is reported.
      await run(
        sql`update stock_balances set quantity = quantity + 1 where lot_id = ${lotA} and location_id = ${chill}`,
      );
      expect(await reconcileStockBalances(handle.db)).toEqual([
        { lotId: lotA, locationId: chill, ledger: 20000, stored: 20001 },
      ]);
    } finally {
      await handle.close();
    }
  }, 120_000);
});
