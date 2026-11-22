import { createDb, type DbHandle } from "@knotworking/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiError } from "./errors";
import { ConcurrencyGate, rowsOf, runAnalyticQuery } from "./services/bi/guard";

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    return err instanceof ApiError ? err.code : String(err);
  }
  return "ok";
};

/** The same checks on each driver: in-memory PGlite always, Postgres when `TEST_POSTGRES_URL` is set. */
const drivers: Array<[string, () => DbHandle]> = [["pglite", () => createDb("memory://")]];
if (process.env.TEST_POSTGRES_URL) drivers.push(["postgres", () => createDb(process.env.TEST_POSTGRES_URL)]);

describe.each(drivers)("analytic query guard (%s)", (_name, open) => {
  let handle: DbHandle;
  beforeAll(() => {
    handle = open();
  });
  afterAll(() => handle.close());

  it("runs a query and reports its estimated cost", async () => {
    const result = await runAnalyticQuery<{ n: number }>(
      handle.db,
      sql`select g::int as n from generate_series(1, ${3}::int) g`,
    );
    expect(result.rows.map((r) => Number(r.n))).toEqual([1, 2, 3]);
    expect(result.truncated).toBe(false);
    expect(result.estimatedCost).toBeGreaterThan(0);
  });

  it("caps rows and says the result was cut", async () => {
    const result = await runAnalyticQuery(handle.db, sql`select g from generate_series(1, 50) g`, {
      rowCap: 10,
    });
    expect(result.rows).toHaveLength(10);
    expect(result.truncated).toBe(true);
    const exact = await runAnalyticQuery(handle.db, sql`select g from generate_series(1, 10) g`, {
      rowCap: 10,
    });
    expect(exact.truncated).toBe(false);
  });

  it("refuses a deliberately heavy query before it runs", async () => {
    const started = Date.now();
    const heavy = sql`select count(*) from generate_series(1, 100000000) a cross join generate_series(1, 1000) b`;
    expect(await code(runAnalyticQuery(handle.db, heavy))).toBe("query_too_expensive");
    // Refused at planning time, so nothing ran.
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("never writes: the transaction is read-only", async () => {
    await handle.db.execute(sql`create table if not exists bi_guard_probe (x int)`);
    await handle.db.execute(sql`create sequence if not exists bi_guard_seq`);
    // Passed as builders, so nothing wraps them in a subquery: only the read-only transaction refuses.
    for (const write of [
      () => sql`with w as (insert into bi_guard_probe values (1) returning x) select * from w`,
      () => sql`select nextval('bi_guard_seq')`,
    ]) {
      const err = await runAnalyticQuery(handle.db, write).then(
        () => null,
        (e: unknown) => e,
      );
      let code: unknown;
      for (let e: any = err, depth = 0; e && depth < 5; e = e.cause, depth++)
        code ??= /^[0-9A-Z]{5}$/.test(e.code) ? e.code : undefined;
      expect(code).toBe("25006");
    }
    const [row] = rowsOf<{ n: number }>(
      await handle.db.execute(sql`select count(*)::int as n from bi_guard_probe`),
    );
    expect(Number(row?.n)).toBe(0);
  });
});

describe.skipIf(!process.env.TEST_POSTGRES_URL)("analytic query guard timeout (postgres)", () => {
  it("cancels a slow query whose cost looked cheap", async () => {
    const handle = createDb(process.env.TEST_POSTGRES_URL);
    try {
      const started = Date.now();
      expect(await code(runAnalyticQuery(handle.db, sql`select pg_sleep(5)`, { timeoutMs: 200 }))).toBe(
        "query_timeout",
      );
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      await handle.close();
    }
  });
});

describe("analytic concurrency gate", () => {
  it("runs at most N at once, queues a bounded number, and refuses the rest", async () => {
    const gate = new ConcurrencyGate(2, 1, 1_000);
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    let peak = 0;
    const job = () =>
      gate.run(async () => {
        peak = Math.max(peak, gate.active);
        await hold;
      });
    const first = [job(), job(), job()];
    expect(gate.active).toBe(2);
    expect(gate.queued).toBe(1);
    await expect(job()).rejects.toMatchObject({ code: "analytics_busy" });
    release();
    await Promise.all(first);
    expect(peak).toBe(2);
    expect(gate.active).toBe(0);
  });

  it("gives up on a queued query after the queue timeout", async () => {
    const gate = new ConcurrencyGate(1, 4, 50);
    let release!: () => void;
    const running = gate.run(() => new Promise<void>((r) => (release = r)));
    await expect(gate.run(async () => "late")).rejects.toMatchObject({ code: "analytics_busy" });
    expect(gate.queued).toBe(0);
    release();
    await running;
    expect(await gate.run(async () => "next")).toBe("next");
  });
});
