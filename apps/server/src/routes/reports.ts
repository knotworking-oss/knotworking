import { timeReportQuerySchema } from "@knotworking/core";
import { Hono } from "hono";
import type { WorkspaceEnv } from "../env";
import { timeReport, timeReportCsv } from "../services/time-report";
import { validate } from "../validate";

/**
 * Time reports (read-only). Mounted by `timeRoutes`.
 *
 * Who may read: every workspace member (owner, admin, member and guest) and every API token of
 * one, for everyone's time. That is deliberately the same visibility time entries already have:
 * `GET /tasks/:id/time-entries`, `GET /projects/:id/time` (which splits time per person) and the
 * bootstrap snapshot hand every member all entries, with person and note. A report only
 * aggregates what they can already read, so restricting it would add no privacy, only
 * inconsistency; if time ever becomes private per person, the entries routes and the bootstrap
 * must change first and these follow. Reports never include email addresses (guests don't get
 * them), only names. Writes stay as they are (`requireWriter` and the owner/admin rules in
 * `services/time-entries.ts`).
 */
export const reportRoutes = new Hono<WorkspaceEnv>()
  .get("/time-report", validate("query", timeReportQuerySchema), async (c) =>
    c.json(await timeReport(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .get("/time-report.csv", validate("query", timeReportQuerySchema), async (c) => {
    const q = c.req.valid("query");
    const csv = await timeReportCsv(c.var.db, c.var.workspace.id, q);
    // Slugs are a-z, 0-9 and "-", and the dates are validated, so the file name needs no escaping.
    const filename = `time-report-${c.var.workspace.slug}-${q.from}-to-${q.to}.csv`;
    return c.body(csv, 200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      // Private data: never cached by a shared proxy, and never sniffed into something executable.
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    });
  });
