import type { Executor } from "@knotworking/db";
import { sql, type SQL } from "drizzle-orm";
import { ApiError } from "../../errors";

/**
 * The analytic query guard. Every dashboard and BI query runs through `runAnalyticQuery`, which
 * keeps one heavy dashboard from stalling the API:
 *
 *  1. **Concurrency.** At most `maxConcurrent` analytic queries run at once per process; up to
 *     `maxQueued` more wait (each for at most `queueTimeoutMs`); the rest are refused as busy.
 *  2. **Cost ceiling.** The planner's estimate (`EXPLAIN`) must be under `maxCost` before the query
 *     runs. This is the guard PGlite relies on: it runs in-process WebAssembly, ignores
 *     `statement_timeout` and cannot interrupt a running statement, so an expensive query has to be
 *     refused before it starts. The check is the same on both drivers.
 *  3. **Statement timeout.** On Postgres, `SET LOCAL statement_timeout` cancels anything that still
 *     runs past `timeoutMs` (a bad estimate). PGlite accepts the setting and ignores it.
 *  4. **Row cap.** At most `rowCap` rows come back; `truncated` says when there were more.
 *
 * The transaction is read-only, so a compiled query can never write.
 */
export interface AnalyticGuardOptions {
  /** Postgres `statement_timeout` for the query, in milliseconds. */
  timeoutMs: number;
  /** Rows returned at most; one more is fetched to tell whether the result was cut. */
  rowCap: number;
  /** Highest planner total cost (`EXPLAIN`) accepted. */
  maxCost: number;
}

export const DEFAULT_ANALYTIC_GUARD: AnalyticGuardOptions = {
  timeoutMs: 10_000,
  rowCap: 5_000,
  // Generous for real dashboards (a full scan and sort of a few hundred thousand rows), and well
  // under a runaway cross join or a generated series of tens of millions.
  maxCost: 5_000_000,
};

export interface AnalyticResult<Row> {
  rows: Row[];
  /** More rows matched than `rowCap`; only the first `rowCap` are returned. */
  truncated: boolean;
  /** The planner's total cost estimate the query was admitted with. */
  estimatedCost: number;
}

/** A bounded concurrency gate with a queue. One per process (see `analyticGate`). */
export class ConcurrencyGate {
  private running = 0;
  private readonly waiting: Array<{ grant: () => void; timer: ReturnType<typeof setTimeout> }> = [];

  constructor(
    readonly maxConcurrent: number,
    readonly maxQueued: number,
    readonly queueTimeoutMs: number,
  ) {}

  get active() {
    return this.running;
  }

  get queued() {
    return this.waiting.length;
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await work();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.running < this.maxConcurrent) {
      this.running++;
      return Promise.resolve();
    }
    if (this.waiting.length >= this.maxQueued) return Promise.reject(busy());
    return new Promise((resolve, reject) => {
      const entry = {
        grant: () => {
          clearTimeout(entry.timer);
          resolve();
        },
        timer: setTimeout(() => {
          const i = this.waiting.indexOf(entry);
          if (i !== -1) this.waiting.splice(i, 1);
          reject(busy());
        }, this.queueTimeoutMs),
      };
      this.waiting.push(entry);
    });
  }

  private release() {
    const next = this.waiting.shift();
    // The slot passes straight to the next waiter, so `running` stays the same.
    if (next) next.grant();
    else this.running--;
  }
}

const busy = () =>
  new ApiError(503, "analytics_busy", "Too many reports are running right now. Try again in a moment.");

/** The process-wide gate every analytic query shares. */
export const analyticGate = new ConcurrencyGate(4, 16, 15_000);

/** Rows from `execute`, whichever driver: postgres.js returns an array, PGlite `{ rows }`. */
export function rowsOf<Row>(result: unknown): Row[] {
  return (Array.isArray(result) ? result : ((result as { rows?: Row[] }).rows ?? [])) as Row[];
}

/** The planner's total cost for a query, without running it. */
export async function estimateCost(db: Executor, query: SQL): Promise<number> {
  const [row] = rowsOf<Record<string, unknown>>(await db.execute(sql`explain (format json) ${query}`));
  let plan = row ? Object.values(row)[0] : undefined;
  if (typeof plan === "string") plan = JSON.parse(plan);
  const cost = (plan as Array<{ Plan?: { "Total Cost"?: number } }> | undefined)?.[0]?.Plan?.["Total Cost"];
  if (typeof cost !== "number") throw new Error("Could not read the query plan's cost");
  return cost;
}

/** Postgres errors caused by input values: invalid text (22P02), datetime format (22007) or range (22008). */
const INPUT_ERRORS = new Set(["22P02", "22007", "22008"]);

/** The SQLSTATE of a driver error (Drizzle wraps it in `cause`). */
function postgresCode(err: unknown): string | undefined {
  for (let e: any = err, depth = 0; e && depth < 5; e = e.cause, depth++) {
    if (typeof e.code === "string" && /^[0-9A-Z]{5}$/.test(e.code)) return e.code;
  }
  return undefined;
}

/** Whether an error is Postgres cancelling a statement (`57014`, e.g. on `statement_timeout`). */
function isQueryCanceled(err: unknown): boolean {
  for (let e: any = err, depth = 0; e && depth < 5; e = e.cause, depth++) {
    if (e.code === "57014") return true;
  }
  return false;
}

/**
 * Runs a compiled analytic query under the guard. Throws `ApiError`s a client can show:
 * `analytics_busy` (503), `query_too_expensive` (422) or `query_timeout` (422).
 */
export async function runAnalyticQuery<Row = Record<string, unknown>>(
  db: Executor,
  /**
   * The statement, or a builder given the row limit to apply (`rowCap + 1`) so it can keep its own
   * ORDER BY and LIMIT together. A plain statement is wrapped in a limited subquery.
   */
  query: SQL | ((limit: number) => SQL),
  options: Partial<AnalyticGuardOptions> = {},
  gate: ConcurrencyGate = analyticGate,
): Promise<AnalyticResult<Row>> {
  const opts = { ...DEFAULT_ANALYTIC_GUARD, ...options };
  const timeoutMs = Math.max(1, Math.floor(opts.timeoutMs));
  const rowCap = Math.max(1, Math.floor(opts.rowCap));
  return gate.run(async () => {
    try {
      return await db.transaction(async (tx) => {
        await tx.execute(sql`set transaction read only`);
        // `SET` takes no bind parameters; the value is an integer built here, never input.
        await tx.execute(sql.raw(`set local statement_timeout = ${timeoutMs}`));
        const statement =
          typeof query === "function"
            ? query(rowCap + 1)
            : sql`select * from (${query}) as q limit ${rowCap + 1}`;
        const estimatedCost = await estimateCost(tx, statement);
        if (estimatedCost > opts.maxCost) {
          throw new ApiError(
            422,
            "query_too_expensive",
            "This query would read too much data. Narrow the period, add filters or group by fewer fields.",
            { estimatedCost, maxCost: opts.maxCost },
          );
        }
        const rows = rowsOf<Row>(await tx.execute(statement));
        const truncated = rows.length > rowCap;
        return { rows: truncated ? rows.slice(0, rowCap) : rows, truncated, estimatedCost };
      });
    } catch (err) {
      const code = postgresCode(err);
      // Values Postgres can't read (a malformed id or date that slipped past validation).
      if (code && INPUT_ERRORS.has(code)) {
        throw new ApiError(400, "invalid_query", "A value in the query isn't valid for its field", {
          postgresCode: code,
        });
      }
      if (isQueryCanceled(err)) {
        throw new ApiError(
          422,
          "query_timeout",
          "This query took too long and was stopped. Narrow the period or add filters.",
        );
      }
      throw err;
    }
  });
}
